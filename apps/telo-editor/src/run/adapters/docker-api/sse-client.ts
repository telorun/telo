import type { RunEvent, RunStatus } from "../../types";

const STORAGE_PREFIX = "telo-editor:sse-last-event-id:";

export interface SseClient {
  close(): void;
}

export interface SseClientDeps {
  url: string;
  sessionId: string;
  onEvent: (event: RunEvent) => void;
  onError: (err: Error) => void;
}

/**
 * Opens an EventSource against the runner's /v1/sessions/:id/events and
 * fans out `stdout` / `stderr` / `status` frames as RunEvents.
 *
 * Resume comes from two independent signals:
 * - Native EventSource auto-reconnect sends `Last-Event-ID` as a header for
 *   transient network blips within the same instance.
 * - A fresh instance (tab reload) has no header — we append `?lastEventId=<n>`
 *   from sessionStorage on construction. The server prefers the header when
 *   both are present.
 */
export function openSseClient(deps: SseClientDeps): SseClient {
  const storageKey = `${STORAGE_PREFIX}${deps.sessionId}`;

  const url = new URL(deps.url, window.location.href);
  const persisted = readPersistedId(storageKey);
  if (persisted !== null && url.searchParams.get("lastEventId") === null) {
    url.searchParams.set("lastEventId", String(persisted));
  }

  const source = new EventSource(url.toString(), { withCredentials: false });
  let closed = false;

  const handleStdout = (e: MessageEvent): void => {
    const parsed = parseRunEvent(e.data);
    if (parsed) {
      persistId(storageKey, e.lastEventId);
      deps.onEvent(parsed);
    }
  };
  const handleStderr = (e: MessageEvent): void => {
    const parsed = parseRunEvent(e.data);
    if (parsed) {
      persistId(storageKey, e.lastEventId);
      deps.onEvent(parsed);
    }
  };
  const handleStatus = (e: MessageEvent): void => {
    const parsed = parseRunEvent(e.data);
    if (parsed) {
      persistId(storageKey, e.lastEventId);
      deps.onEvent(parsed);
      if (parsed.type === "status" && isTerminal(parsed.status)) {
        close();
      }
    }
  };
  const handleGap = (): void => {
    deps.onEvent({
      type: "stderr",
      chunk: "\n[stream reconnected — earlier output truncated]\n",
    });
  };
  const handleError = (): void => {
    // EventSource fires `error` on transient disconnects too — it reconnects
    // automatically. Only surface to the caller when we've already closed or
    // the readyState is CLOSED.
    if (source.readyState === EventSource.CLOSED) {
      deps.onError(new Error("runner stream closed"));
      close();
    }
  };

  source.addEventListener("stdout", handleStdout);
  source.addEventListener("stderr", handleStderr);
  source.addEventListener("status", handleStatus);
  source.addEventListener("gap", handleGap);
  source.addEventListener("error", handleError);

  function close(): void {
    if (closed) return;
    closed = true;
    source.removeEventListener("stdout", handleStdout);
    source.removeEventListener("stderr", handleStderr);
    source.removeEventListener("status", handleStatus);
    source.removeEventListener("gap", handleGap);
    source.removeEventListener("error", handleError);
    source.close();
  }

  return { close };
}

function parseRunEvent(raw: string): RunEvent | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRunEvent(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isRunEvent(value: unknown): value is RunEvent {
  if (!value || typeof value !== "object") return false;
  const v = value as { type?: unknown };
  return v.type === "stdout" || v.type === "stderr" || v.type === "status";
}

function isTerminal(status: RunStatus): boolean {
  return status.kind === "exited" || status.kind === "failed" || status.kind === "stopped";
}

function readPersistedId(key: string): number | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

function persistId(key: string, raw: string): void {
  if (!raw) return;
  try {
    window.sessionStorage.setItem(key, raw);
  } catch {
    // sessionStorage can be disabled/full — resume will simply not work,
    // which is the same as v1 degraded mode.
  }
}
