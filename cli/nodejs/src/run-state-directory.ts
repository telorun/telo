import { resolveEntryDir, resolveWorkspaceDir } from "@telorun/kernel";
import * as path from "node:path";
import { realPath } from "./workspace-marker.js";

/** The leaf that keeps one application's state directory from being another's `needs/` or `apps/`. */
const LEAF = "_";

export interface RunStateDirectoryInput {
  /** The entry as `telo run` was given it (a path, or an `http(s)` / `oci://` ref). */
  entry: string;
  /** A packaged executable's payload is not where the app lives: it anchors at the working directory. */
  packaged: boolean;
  cwd: string;
}

/**
 * The `TELO_HOST_STATE_DIR` a plain `telo run` falls back to:
 * `<workspace dir>/.telo/state/<app directory relative to it>/_`. Derived every
 * run from the entry's place alone, so nothing is saved and `TELO_CACHE_DIR` does
 * not move it. A packaged executable and an entry with no local file anchor at
 * the working directory with the key `_`.
 */
export function defaultRunStateDirectory(input: RunStateDirectoryInput): string {
  const anchored = input.packaged ? null : localAnchor(input.entry);
  if (!anchored) return path.join(input.cwd, ".telo", "state", LEAF);
  const relative = path.relative(realPath(anchored.workspaceDir), realPath(anchored.entryDir));
  return path.join(anchored.workspaceDir, ".telo", "state", relative, LEAF);
}

function localAnchor(entry: string): { workspaceDir: string; entryDir: string } | null {
  const workspaceDir = resolveWorkspaceDir(entry);
  const entryDir = resolveEntryDir(entry);
  return workspaceDir && entryDir ? { workspaceDir, entryDir } : null;
}
