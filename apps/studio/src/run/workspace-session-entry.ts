import { LOCAL_PREFIXES } from "../storage-keys";
import type { ResumeSecretScope, ResumeSecretStore } from "./runner-credentials";

/**
 * How a workspace is used, chosen the first time it opens:
 *  - `agent`  — a runner session with the co-resident agent;
 *  - `manual` — a runner session, no agent;
 *  - `device` — no runner is contacted at all.
 */
export type WorkspaceMode = "agent" | "manual" | "device";

/**
 * What this device remembers about one workspace, under
 * `telo-studio:session:v1:<workspaceKey>`. `workspace` is the name the session
 * is created under; `runner` and `sessionId` say where it lives once created.
 * `owner` is `identity` for a session the signed-in identity owns, which is
 * forgotten on sign-out; absent, the session is a resume secret's.
 * `resumeSecret` is present only where the secret store is this entry.
 */
export interface WorkspaceSessionEntry {
  mode: WorkspaceMode;
  workspace: string;
  runner?: string;
  sessionId?: string;
  owner?: "identity";
  resumeSecret?: string;
}

const MODES: ReadonlySet<string> = new Set<WorkspaceMode>(["agent", "manual", "device"]);

function keyOf(workspaceKey: string): string {
  return `${LOCAL_PREFIXES.session}${workspaceKey}`;
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && value !== "");
}

/** The stored entry, or null when the workspace was never opened here or the
 *  stored value is not one this build wrote. */
export function loadWorkspaceSessionEntry(workspaceKey: string): WorkspaceSessionEntry | null {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(keyOf(workspaceKey));
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const e = parsed as Record<string, unknown>;
  if (typeof e.mode !== "string" || !MODES.has(e.mode)) return null;
  if (typeof e.workspace !== "string" || e.workspace === "") return null;
  if (!optionalString(e.runner) || !optionalString(e.sessionId) || !optionalString(e.resumeSecret)) {
    return null;
  }
  if (e.owner !== undefined && e.owner !== "identity") return null;
  return {
    mode: e.mode as WorkspaceMode,
    workspace: e.workspace,
    ...(e.runner !== undefined ? { runner: e.runner } : {}),
    ...(e.sessionId !== undefined ? { sessionId: e.sessionId } : {}),
    ...(e.owner !== undefined ? { owner: e.owner } : {}),
    ...(e.resumeSecret !== undefined ? { resumeSecret: e.resumeSecret } : {}),
  };
}

/** Every workspace this device keeps an entry for, by workspace key. */
export function listWorkspaceSessionEntries(): Array<{ workspaceKey: string; entry: WorkspaceSessionEntry }> {
  const found: Array<{ workspaceKey: string; entry: WorkspaceSessionEntry }> = [];
  const storage = window.localStorage;
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(LOCAL_PREFIXES.session)) continue;
    const workspaceKey = key.slice(LOCAL_PREFIXES.session.length);
    const entry = loadWorkspaceSessionEntry(workspaceKey);
    if (entry) found.push({ workspaceKey, entry });
  }
  return found;
}

/** Sign-out: the sessions the identity owns stay its own on their runners, and
 *  this device forgets them — the identity finds them again by listing once
 *  signed in. */
export function forgetIdentitySessions(): void {
  for (const { workspaceKey, entry } of listWorkspaceSessionEntries()) {
    if (entry.owner !== "identity") continue;
    const next: WorkspaceSessionEntry = { ...entry };
    delete next.sessionId;
    delete next.owner;
    saveWorkspaceSessionEntry(workspaceKey, next);
  }
}

export function saveWorkspaceSessionEntry(workspaceKey: string, entry: WorkspaceSessionEntry): void {
  window.localStorage.setItem(keyOf(workspaceKey), JSON.stringify(entry));
}

/**
 * The name a new session is created under: a Telo Cloud working copy names its
 * project, so the same project matches on every device; any other workspace is
 * named by an id minted on this device.
 */
export function sessionWorkspaceName(cloudProjectId: string | null): string {
  return cloudProjectId ?? `device:${crypto.randomUUID()}`;
}

/** The entry a workspace gets when its mode is first chosen. */
export function newWorkspaceSessionEntry(mode: WorkspaceMode, cloudProjectId: string | null): WorkspaceSessionEntry {
  return { mode, workspace: sessionWorkspaceName(cloudProjectId) };
}

function withResumeSecret(entry: WorkspaceSessionEntry, secret: string | null): WorkspaceSessionEntry {
  const next: WorkspaceSessionEntry = { ...entry };
  if (secret === null) delete next.resumeSecret;
  else next.resumeSecret = secret;
  return next;
}

/** The web build's resume-secret store: the secret sits in the workspace's own
 *  entry, so it is forgotten with it. */
export function entryResumeSecretStore(): ResumeSecretStore {
  return {
    async read({ runner, workspaceKey }: ResumeSecretScope) {
      const entry = loadWorkspaceSessionEntry(workspaceKey);
      return entry?.runner === runner ? (entry.resumeSecret ?? null) : null;
    },
    async write({ runner, workspaceKey }: ResumeSecretScope, secret) {
      const entry = loadWorkspaceSessionEntry(workspaceKey);
      if (!entry) throw new Error(`No session entry is stored for workspace '${workspaceKey}'.`);
      if (secret !== null && entry.runner !== runner) {
        throw new Error(`The session entry for workspace '${workspaceKey}' names another runner.`);
      }
      saveWorkspaceSessionEntry(workspaceKey, withResumeSecret(entry, secret));
    },
  };
}
