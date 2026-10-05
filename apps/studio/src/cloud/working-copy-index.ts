import { LOCAL_KEYS } from "../storage-keys";
import type { WorkspaceRole } from "./api";

/** One working copy on this device. Nothing here is secret. */
export interface WorkingCopyEntry {
  userId: string;
  orgId: string;
  workspaceId: string;
  /** Shown where the workspace is named while Cloud is not asked. */
  workspaceName: string;
  /** The caller's role when the workspace was last listed. */
  role: WorkspaceRole;
  branch: string;
  baseCommit: string | null;
  /** A commit that was sent and not yet seen to land: the key it was sent
   *  under and what it was a commit of, so a retry — after a reload too —
   *  reuses the key and yields one commit. */
  pendingCommit?: { key: string; fingerprint: string };
}

export function loadWorkingCopyIndex(): WorkingCopyEntry[] {
  try {
    const raw = window.localStorage.getItem(LOCAL_KEYS.cloudWorkingCopies);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as WorkingCopyEntry[]) : [];
  } catch {
    return [];
  }
}

function save(entries: WorkingCopyEntry[]): void {
  window.localStorage.setItem(LOCAL_KEYS.cloudWorkingCopies, JSON.stringify(entries));
}

export function findWorkingCopy(workspaceId: string): WorkingCopyEntry | null {
  return loadWorkingCopyIndex().find((e) => e.workspaceId === workspaceId) ?? null;
}

export function putWorkingCopy(entry: WorkingCopyEntry): void {
  save([...loadWorkingCopyIndex().filter((e) => e.workspaceId !== entry.workspaceId), entry]);
}

export function updateWorkingCopy(
  workspaceId: string,
  change: (entry: WorkingCopyEntry) => WorkingCopyEntry,
): void {
  save(loadWorkingCopyIndex().map((e) => (e.workspaceId === workspaceId ? change(e) : e)));
}

export function forgetWorkingCopy(workspaceId: string): void {
  save(loadWorkingCopyIndex().filter((e) => e.workspaceId !== workspaceId));
}
