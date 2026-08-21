/**
 * Finding `telo-workspace.yaml` on disk.
 *
 * Its LOCATION is a general anchor — the directory workspace-relative paths are
 * measured from, the outer bound on how far a walk-up may look, and the root the
 * `.telo` cache is anchored at — while its `modules:` list is release scope. So
 * the finder is deliberately separate from `release/`: `telo run` bounds its
 * `.env` collection with the marker and `resolveCacheRoot` anchors on it, and
 * neither may reach into the release namespace to do so, where `loadWorkspace`
 * (which parses `modules:` and throws when the file is absent) sits one import
 * away.
 *
 * It lives in the KERNEL rather than the CLI because the cache root is resolved
 * here, on a path a CLI-less embedder also takes (a child kernel started through
 * the runtime seam, a test harness). The CLI re-exports it; nothing is duplicated.
 *
 * Parsing the file is the analyzer's (`release/workspace-config.ts`); finding it
 * is the Node half, and this is all of it.
 */

import { WORKSPACE_FILENAME } from "@telorun/analyzer";
import * as fs from "node:fs";
import * as path from "node:path";

export { WORKSPACE_FILENAME };

/**
 * Walk up from `from` looking for the marker. Returns the directory holding it,
 * or `undefined` — the file is optional. `telo release` requires one and reports
 * its absence; `telo run` and `resolveCacheRoot` read `undefined` as "no parent
 * lookup", falling back to what they did before the marker existed.
 *
 * `from` is resolved through symlinks first: a manifest reached through a linked
 * directory would otherwise walk the LINK's parents, miss a marker that is right
 * there in the real tree, and silently fall back to a narrower answer.
 */
export function findWorkspaceRoot(from: string): string | undefined {
  let dir = realPath(path.resolve(from));
  for (;;) {
    if (isFile(path.join(dir, WORKSPACE_FILENAME))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The marker must be a FILE. `existsSync` would accept a directory of that name
 *  and anchor the whole cache on it, and the Rust half tests `is_file()` — a
 *  workspace visible to one kernel and not the other is precisely the divergence
 *  a shared marker exists to prevent. */
function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/** `fs.realpathSync`, falling back to the input when the path does not exist —
 *  a manifest path that is wrong is the caller's error to report, not this
 *  helper's to convert into a different one. */
export function realPath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}
