import { SESSION_PREFIXES } from "../../../storage-keys";
import { isTerminal, type RunEvent } from "../../types";

const STORAGE_PREFIX = SESSION_PREFIXES.runSseEventId;

export interface SseClient {
  close(): void;
}

export interface SseClientDeps {
  url: string;
  sessionId: string;
  onEvent: (event: RunEvent) => void;
  onError: (err: Error) => void;
  /** Resume from the very start (lastEventId=0), replaying the runner's full
   *  buffered history regardless of any per-tab checkpoint. Used when re-attaching
   *  to a session after a page reload, where the in-memory record is empty and
   *  must be refilled from scratch. */
  replayFromStart?: boolean;
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
  if (deps.replayFromStart) {
    // Cold re-attach: replay the full event history and drop the stale per-tab
    // checkpoint so it can't shadow the from-zero replay.
    url.searchParams.set("lastEventId", "0");
    clearPersistedId(storageKey);
  } else {
    const persisted = readPersistedId(storageKey);
    if (persisted !== null && url.searchParams.get("lastEventId") === null) {
      url.searchParams.set("lastEventId", String(persisted));
    }
  }

  const source = new EventSource(url.toString(), { withCredentials: false });
  let closed = false;

  // Every named event forwards identically — the SSE `event:` name is the
  // discriminator the payload already carries — so one handler serves them all
  // and adding an event type is one entry in the list below.
  const forward = (e: MessageEvent): void => {
    const parsed = parseRunEvent(e.data);
    if (parsed) {
      persistId(storageKey, e.lastEventId);
      deps.onEvent(parsed);
    }
  };

  const handleGap = (): void => {
    // A replay gap is a fact about the STREAM, not output from the workload —
    // workload bytes travel the byte channel — so it is reported as a
    // provisioning message rather than synthesized into the app's own output.
    deps.onEvent({
      type: "progress",
      phase: "boot",
      message: "stream reconnected — earlier events truncated",
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

  const FORWARDED = ["status", "progress", "debug", "reachability", "run", "endpoints"];
  for (const name of FORWARDED) source.addEventListener(name, forward);
  source.addEventListener("gap", handleGap);
  source.addEventListener("error", handleError);

  function close(): void {
    if (closed) return;
    closed = true;
    for (const name of FORWARDED) source.removeEventListener(name, forward);
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
  return (
    v.type === "run" ||
    v.type === "endpoints" ||
    v.type === "status" ||
    v.type === "progress" ||
    v.type === "debug" ||
    v.type === "reachability"
  );
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

function clearPersistedId(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    /* sessionStorage unavailable — nothing to clear */
  }
}
