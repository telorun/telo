import type { RunBundle, WorkspaceChangeSet } from "./types";

/** The files the editor last pushed into a watch session's workspace, by path.
 *  Keeping it is what lets a save produce a MINIMAL change set. */
export type SyncedFiles = Map<string, string>;

export function bundleFiles(bundle: RunBundle): SyncedFiles {
  return new Map(bundle.files.map((f) => [f.relativePath, f.contents]));
}

/**
 * The change set that takes a watch session's workspace from `previous` to
 * `next`.
 *
 * Diffing rather than re-pushing the whole bundle is load-bearing, not an
 * optimization: the kernel's watcher fires on a write, so an unconditional
 * re-push would reload every app on every save — including saves to a file that
 * app never reads. The diff means a save reloads exactly the apps whose files
 * actually moved.
 *
 * A removed file becomes an explicit delete, because a watch workspace is
 * long-lived: a file the user deleted has to leave the running workspace, and
 * absence-means-delete is not something a write list can express.
 */
export function diffBundle(previous: SyncedFiles, next: SyncedFiles): WorkspaceChangeSet {
  const write: WorkspaceChangeSet["write"] = [];
  for (const [path, content] of next) {
    if (previous.get(path) !== content) write.push({ path, content });
  }
  const remove: string[] = [];
  for (const path of previous.keys()) {
    if (!next.has(path)) remove.push(path);
  }
  const changes: WorkspaceChangeSet = {};
  if (write.length > 0) changes.write = write;
  if (remove.length > 0) changes.delete = remove;
  return changes;
}

/** True when a change set would touch nothing — the caller skips the round trip
 *  AND the reload it would cause. */
export function isEmptyChangeSet(changes: WorkspaceChangeSet): boolean {
  return (changes.write?.length ?? 0) === 0 && (changes.delete?.length ?? 0) === 0;
}
