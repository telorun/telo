/**
 * `.env` / `.env.local` collection for `telo run`.
 *
 * **The workspace marker is the bound, and its absence is the old behaviour.**
 * A walk-up needs a stop: walking to `/` would read a user's home `.env.local`
 * into an app run, and stopping at `.git` would tie env resolution to a VCS a
 * deployed checkout may not have. `telo-workspace.yaml` is already the anchor
 * every workspace-relative path is measured from, so it is the honest boundary
 * for "this repo". Only its LOCATION is read — never its `modules:` list, which
 * is release scope and says nothing about env, which is why a manifest under
 * `examples/` (in no release subtree) still gets the full walk.
 *
 * With no marker anywhere above the manifest the walk collapses to the
 * manifest's own directory, which is what this did before the bound existed, so
 * the file stays harmless by its absence: it enables the parent lookup rather
 * than gating one, and deleting it cannot silently drop a variable an app had.
 *
 * Precedence (highest first): the real environment > nearest `.env.local` >
 * nearest `.env` > the same pair one directory up, and so on. A repo-root file
 * reaches every manifest beneath it, so a nearer declaration has to win.
 *
 * **Resolving is separate from applying**, so the walk is answerable without
 * touching `process.env` or writing a line of output — the caller owns both.
 */

import * as dotenv from "dotenv";
import * as fs from "node:fs";
import * as path from "node:path";
import { findWorkspaceRoot, realPath } from "./workspace-marker.js";

/** One file the walk could not read for a reason other than its absence. */
export interface UnreadableEnvFile {
  readonly path: string;
  /** The errno code (`EACCES`, `EISDIR`, …), or the message when there is none. */
  readonly reason: string;
}

export interface EnvFileResolution {
  /** The merged values, precedence already applied. Never written anywhere by
   *  this module. */
  readonly values: Readonly<Record<string, string>>;
  /** The files that contributed, in the order they were merged (farthest
   *  ancestor first, so the last entry is the one that won a conflict). */
  readonly loaded: readonly string[];
  /** Files that exist but could not be read. Reporting these is the caller's,
   *  and it is not optional: an unreadable `.env` is indistinguishable from an
   *  absent one to everything downstream. */
  readonly unreadable: readonly UnreadableEnvFile[];
}

const FILENAMES = [".env", ".env.local"] as const;

/** Collect the env files visible to a manifest. Pure: reads the filesystem and
 *  returns what it found. */
export function resolveEnvFiles(manifestPath: string): EnvFileResolution {
  const loaded: string[] = [];
  const unreadable: UnreadableEnvFile[] = [];
  const values: Record<string, string> = {};

  // Farthest-first, so each nearer directory overwrites what the one above set.
  for (const directory of envDirectories(manifestDirectory(manifestPath)).reverse()) {
    for (const name of FILENAMES) {
      const file = path.join(directory, name);
      const text = readEnvFile(file, unreadable);
      if (text === undefined) continue;
      loaded.push(file);
      Object.assign(values, dotenv.parse(text));
    }
  }
  return { values, loaded, unreadable };
}

/** The directory holding the manifest — or the path itself when it names a
 *  directory. Resolved through symlinks, so the walk climbs the real tree. */
function manifestDirectory(manifestPath: string): string {
  const resolved = realPath(path.resolve(manifestPath));
  return fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
    ? resolved
    : path.dirname(resolved);
}

/** The manifest's directory, then each ancestor up to and including the
 *  workspace root. Nearest first; just the one directory when no marker sits
 *  above it. */
function envDirectories(from: string): string[] {
  const root = findWorkspaceRoot(from);
  if (root === undefined) return [from];
  const dirs: string[] = [];
  for (let dir = from; ; dir = path.dirname(dir)) {
    dirs.push(dir);
    if (dir === root || path.dirname(dir) === dir) break;
  }
  return dirs;
}

/**
 * `undefined` when the file is genuinely not there, its text when it is.
 *
 * Only absence is silent. Anything else — a root-owned `.env.local` in a shared
 * checkout, a directory where a file is expected — is recorded, because the
 * alternative is an app booting without a variable the developer can see in the
 * file and a later `ERR_MANIFEST_VALIDATION_FAILED` naming it.
 */
function readEnvFile(file: string, unreadable: UnreadableEnvFile[]): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    unreadable.push({ path: file, reason: code ?? String(err) });
    return undefined;
  }
}
