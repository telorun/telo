import { LOCAL_KEYS } from "../storage-keys";
import type { ProjectRole } from "./api";

/** One working copy on this device. Nothing here is secret. */
export interface WorkingCopyEntry {
  userId: string;
  orgId: string;
  projectId: string;
  /** Shown where the project is named while Cloud is not asked. */
  projectName: string;
  /** The caller's role when the project was last listed. */
  role: ProjectRole;
  branch: string;
  baseCommit: string | null;
  /** A commit that was sent and not yet seen to land: the key it was sent
   *  under and what it was a commit of, so a retry — after a reload too —
   *  reuses the key and yields one commit. */
  pendingCommit?: { key: string; fingerprint: string };
}

/** A working copy stored before Cloud named its projects: its id names nothing
 *  Cloud still has, so it can only be removed. */
export interface OrphanedWorkingCopy {
  id: string;
  name: string;
}

function stored(): Record<string, unknown>[] {
  try {
    const raw = window.localStorage.getItem(LOCAL_KEYS.cloudWorkingCopies);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is Record<string, unknown> => typeof e === "object" && e !== null,
    );
  } catch {
    return [];
  }
}

function isOrphaned(entry: Record<string, unknown>): boolean {
  return typeof entry.projectId !== "string" && typeof entry.workspaceId === "string";
}

export function loadWorkingCopyIndex(): WorkingCopyEntry[] {
  return stored().filter((e) => typeof e.projectId === "string") as unknown as WorkingCopyEntry[];
}

export function loadOrphanedWorkingCopies(): OrphanedWorkingCopy[] {
  return stored()
    .filter(isOrphaned)
    .map((e) => ({
      id: e.workspaceId as string,
      name: typeof e.workspaceName === "string" ? e.workspaceName : (e.workspaceId as string),
    }));
}

export function forgetOrphanedWorkingCopy(id: string): void {
  window.localStorage.setItem(
    LOCAL_KEYS.cloudWorkingCopies,
    JSON.stringify(stored().filter((e) => !(isOrphaned(e) && e.workspaceId === id))),
  );
}

function save(entries: WorkingCopyEntry[]): void {
  window.localStorage.setItem(
    LOCAL_KEYS.cloudWorkingCopies,
    JSON.stringify([...stored().filter(isOrphaned), ...entries]),
  );
}

export function findWorkingCopy(projectId: string): WorkingCopyEntry | null {
  return loadWorkingCopyIndex().find((e) => e.projectId === projectId) ?? null;
}

export function putWorkingCopy(entry: WorkingCopyEntry): void {
  save([...loadWorkingCopyIndex().filter((e) => e.projectId !== entry.projectId), entry]);
}

export function updateWorkingCopy(
  projectId: string,
  change: (entry: WorkingCopyEntry) => WorkingCopyEntry,
): void {
  save(loadWorkingCopyIndex().map((e) => (e.projectId === projectId ? change(e) : e)));
}

export function forgetWorkingCopy(projectId: string): void {
  save(loadWorkingCopyIndex().filter((e) => e.projectId !== projectId));
}
