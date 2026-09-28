import { LOCAL_KEYS } from "../storage-keys";
import type { RunnerEndpoint, RunStatus } from "./types";

const KEY = LOCAL_KEYS.runIndex;

/** A persisted pointer to one run, enough to rebuild its history-list entry and
 *  re-attach to the still-live session on the runner after a page reload. The
 *  heavy data (console output, inspection events, terminal scrollback) is never
 *  stored here — it is re-fetched from the owning runner on demand. */
export interface PersistedRunEntry {
  id: string;
  appPath: string;
  adapterId: string;
  adapterDisplayName: string;
  hasTerminal: boolean;
  startedAt: number;
  /** Last-known status, shown in the list until the session is opened and its
   *  status reconciled against the runner. Persisted WITHOUT the runner-minted
   *  endpoint tokens: a token is a live credential, and the one a re-attached
   *  session needs arrives again on the runner's status stream. */
  status: RunStatus;
  /** The adapter config used to start the run — the address (e.g. runner
   *  `baseUrl` / docker host) needed to re-attach.
   *
   *  INVARIANT: adapter config MUST NOT carry secrets. It is persisted verbatim
   *  to localStorage to recover the runner address across reloads; per-run
   *  secrets (`request.env`) are deliberately never stored here. If a runner
   *  config ever grows an auth token, do not persist the whole config — narrow
   *  this to an explicit, secret-free reattach descriptor the adapter opts into. */
  config: unknown;
}

function isStatus(value: unknown): value is RunStatus {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return (
    kind === "starting" ||
    kind === "running" ||
    kind === "exited" ||
    // Not terminal: the pod was reaped for idleness and the session resumes
    // under the same id. Dropping the entry — which is what omitting this kind
    // did — left a session running on the runner that the editor could no
    // longer name, and so could no longer stop.
    kind === "suspended" ||
    kind === "failed" ||
    kind === "stopped"
  );
}

function isEntry(value: unknown): value is PersistedRunEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.appPath === "string" &&
    typeof e.adapterId === "string" &&
    typeof e.adapterDisplayName === "string" &&
    typeof e.hasTerminal === "boolean" &&
    typeof e.startedAt === "number" &&
    isStatus(e.status)
  );
}

export function loadRunIndex(): PersistedRunEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry);
  } catch {
    return [];
  }
}

function withoutToken(endpoint: RunnerEndpoint): RunnerEndpoint {
  const { token, ...rest } = endpoint;
  return rest;
}

/** The status as it may be stored: every endpoint's `token` removed. */
function persistableStatus(status: RunStatus): RunStatus {
  if (status.kind !== "running") return status;
  return {
    ...status,
    ...(status.endpoints ? { endpoints: status.endpoints.map(withoutToken) } : {}),
    ...(status.agent ? { agent: withoutToken(status.agent) } : {}),
  };
}

export function saveRunIndex(entries: PersistedRunEntry[]): void {
  if (typeof window === "undefined") return;
  const stored = entries.map((entry) => ({ ...entry, status: persistableStatus(entry.status) }));
  try {
    window.localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // localStorage may be full or unavailable — resume simply won't work next
    // reload, which is the same as the pre-feature behaviour.
  }
}
