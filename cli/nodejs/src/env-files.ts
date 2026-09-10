/**
 * `.env` / `.env.local` collection for `telo run`.
 *
 * **The workspace marker bounds the walk, and its `env:` block says how.** A
 * walk-up needs a stop: walking to `/` would read a user's home `.env.local`
 * into an app run, and stopping at `.git` would tie env resolution to a VCS a
 * deployed checkout may not have. `telo-workspace.yaml` is already the anchor
 * every workspace-relative path is measured from, so it is the honest boundary
 * for "this repo" — and `env.roots` is how a workspace draws a tighter one,
 * which is what keeps a vendor subtree's apps from reading a repo-root `.env`.
 *
 * With no marker anywhere above the manifest the walk collapses to the
 * manifest's own directory, which is what this did before the bound existed, so
 * the file stays harmless by its absence: it enables the parent lookup rather
 * than gating one, and deleting it cannot silently drop a variable an app had.
 *
 * Precedence (highest first): the real environment > the nearest directory's
 * files, last-declared winning within one directory > the same, one directory
 * up, and so on. A repo-root file reaches every manifest beneath it, so a nearer
 * declaration has to win.
 *
 * **Only `env:` is consulted, and only its diagnostics stop a run.** A typo
 * under `release.modules` is a block this command has no interest in, so it is
 * reported and the run proceeds — aborting every app in a workspace over a
 * release typo is not a trade to make silently. A diagnostic inside `env:` is
 * fatal: degrading to the marker-wide bound there would WIDEN the walk, which is
 * the leak the block exists to prevent, and a block that opted into a boundary
 * and got nothing is a defect rather than a default.
 *
 * **Resolving is separate from applying**, so the walk is answerable without
 * touching `process.env` or writing a line of output — the caller owns both.
 */

import {
  DEFAULT_ENV_FILES,
  WORKSPACE_FILENAME,
  diagnosticsFor,
  hasError,
  matchesPatterns,
  readWorkspaceConfig,
  type WorkspaceDiagnostic,
} from "@telorun/analyzer";
import { lastMatchIndex } from "@telorun/glob";
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
  /** What the marker got wrong. Anything anchored outside `env:` is reported and
   *  survivable; an error inside it is why `failed` is set. */
  readonly diagnostics: readonly WorkspaceDiagnostic[];
  /** Set when `env:` itself could not be read, so the caller must refuse rather
   *  than run against a boundary it had to guess at. */
  readonly failed?: string;
}

/** Collect the env files visible to a manifest. Pure: reads the filesystem and
 *  returns what it found. */
export function resolveEnvFiles(manifestPath: string): EnvFileResolution {
  const loaded: string[] = [];
  const unreadable: UnreadableEnvFile[] = [];
  const values: Record<string, string> = {};

  const from = manifestDirectory(manifestPath);
  const root = findWorkspaceRoot(from);
  const marker = readMarker(root);
  const envErrors = diagnosticsFor(marker.diagnostics, "env");
  if (hasError(envErrors)) {
    return {
      values,
      loaded,
      unreadable,
      diagnostics: marker.diagnostics,
      failed: envErrors.find((diagnostic) => diagnostic.severity === "error")!.message,
    };
  }

  const files = marker.config.env?.files ?? DEFAULT_ENV_FILES;
  // Farthest-first, so each nearer directory overwrites what the one above set.
  for (const directory of envDirectories(from, root, marker.config.env?.roots).reverse()) {
    for (const name of files) {
      const file = path.join(directory, name);
      const text = readEnvFile(file, unreadable);
      if (text === undefined) continue;
      loaded.push(file);
      Object.assign(values, dotenv.parse(text));
    }
  }
  return { values, loaded, unreadable, diagnostics: marker.diagnostics };
}

function readMarker(root: string | undefined): ReturnType<typeof readWorkspaceConfig> {
  if (!root) return { config: {}, diagnostics: [] };
  const file = path.join(root, WORKSPACE_FILENAME);
  try {
    return readWorkspaceConfig(fs.readFileSync(file, "utf8"), WORKSPACE_FILENAME);
  } catch (err) {
    // Reported, never swallowed. The marker was found by walking for it, so a
    // read failure is a race or a permission problem — and degrading to "no
    // blocks" would drop `env.roots` and read exactly the files the block was
    // written to exclude, with no signal at all. Anchored at the document, which
    // is inside every block's scope, so the run refuses.
    return {
      config: {},
      diagnostics: [
        {
          code: "WORKSPACE_INVALID_VALUE",
          severity: "error",
          message:
            `${WORKSPACE_FILENAME} could not be read (${(err as NodeJS.ErrnoException).code ?? String(err)}). ` +
            `It bounds which .env files this run may read, so its contents cannot be assumed.`,
          path: [],
        },
      ],
    };
  }
}

/** The directory holding the manifest — or the path itself when it names a
 *  directory. Resolved through symlinks, so the walk climbs the real tree. */
function manifestDirectory(manifestPath: string): string {
  const resolved = realPath(path.resolve(manifestPath));
  return fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
    ? resolved
    : path.dirname(resolved);
}

/**
 * The manifest's directory, then each ancestor up to and including the bound.
 *
 * The bound is the nearest ancestor matching `env.roots`, else the workspace
 * root; with no marker it is the manifest's own directory. Two `roots` matches
 * need no refusal — unlike two `release.modules` entries, which contradict about
 * a destination, two bounds differ only in tightness and the nearest is the
 * answer.
 */
function envDirectories(
  from: string,
  root: string | undefined,
  roots: readonly string[] | undefined,
): string[] {
  if (root === undefined) return [from];
  const dirs: string[] = [];
  for (let dir = from; ; dir = path.dirname(dir)) {
    dirs.push(dir);
    if (dir === root || path.dirname(dir) === dir) break;
    if (roots?.length) {
      const rel = path.relative(root, dir).split(path.sep).join("/");
      if (rel !== "" && matchesPatterns(rel, roots, lastMatchIndex)) break;
    }
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
