/**
 * Which env files a run reads, and what they say — one answer for every host.
 *
 * **The workspace marker bounds the walk, and its `env:` block says how.** A
 * walk-up needs a stop: walking to the root would read a user's home
 * `.env.local` into an app run, and stopping at `.git` would tie env resolution
 * to a VCS a deployed checkout may not have. `telo-workspace.yaml` is already
 * the anchor every workspace-relative path is measured from, so it is the
 * honest boundary for "this repo" — and `env.roots` is how a workspace draws a
 * tighter one, which keeps a vendor subtree's apps from reading a repo-root
 * `.env`. With no marker found, the walk collapses to the start directory,
 * which is what a run did before the bound existed, so the file enables the
 * parent lookup rather than gating one.
 *
 * Precedence: the nearest directory's files, the later entry of `env.files`
 * winning within one directory, over the same one directory up, and so on. A
 * repo-root file reaches every manifest beneath it, so a nearer declaration has
 * to win. Whether the host's own environment outranks the files is the host's
 * policy, not this function's: a run lets the shell win, Studio has no shell.
 *
 * **Only `env:` can stop a resolution.** A typo under `release.modules` is
 * reported and the values still resolve; an error inside `env:` is fatal,
 * because degrading to the marker-wide bound would WIDEN the walk, and a block
 * that opted into a boundary and got nothing is a defect rather than a default.
 * A marker that is found and cannot be read is fatal for the same reason.
 *
 * **Everything outside the walk is the host's**: it injects the one read every
 * file goes through, chooses the start directory (a manifest's, or a packaged
 * application's working directory) and resolves symbolic links before handing
 * it over. This side lists no directory — a directory a run may cross without
 * listing would otherwise refuse — and applies and prints nothing.
 */

import {
  DEFAULT_ENV_FILES,
  WORKSPACE_FILENAME,
  diagnosticsFor,
  hasError,
  matchesPatterns,
  readWorkspaceConfig,
  type EnvFileEntry,
  type WorkspaceDiagnostic,
} from "../release/workspace-config.js";
import { lastMatchIndex } from "@telorun/glob";
import { envFileValues } from "./env-file-format.js";
import {
  isWithinWorkspacePath,
  workspacePath,
  workspacePathJoin,
  workspacePathParent,
  workspacePathRelative,
} from "./workspace-path.js";

/** What one read of a file found. */
export type EnvFileRead =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "missing" }
  | { readonly kind: "not-a-file" }
  | { readonly kind: "unreadable"; readonly reason: string };

/** The host's one read, of an absolute `/`-separated path (`workspace-path.ts`). */
export type ReadEnvFile = (path: string) => Promise<EnvFileRead>;

export interface ResolveWorkspaceEnvOptions {
  /** The directory the walk starts at, symbolic links already resolved. */
  readonly start: string;
  /** The highest directory the marker search may look in; the root when
   *  omitted. `start` must be at or beneath it. */
  readonly ceiling?: string;
  readonly read: ReadEnvFile;
}

export interface EnvFileContribution {
  readonly path: string;
  /** Its `env.files` entry is marked sensitive. */
  readonly sensitive: boolean;
}

/** A file that exists and could not be read. Reporting it is the host's, and it
 *  is not optional: to everything downstream it looks like an absent one. */
export interface UnreadableEnvFile {
  readonly path: string;
  readonly reason: string;
}

export interface WorkspaceEnvResolution {
  /** The merged values, precedence applied. */
  readonly values: Readonly<Record<string, string>>;
  /** Per value, the file its winning assignment is in. */
  readonly sources: Readonly<Record<string, string>>;
  /** The files that contributed, in merge order — farthest first, so a later
   *  file won any conflict with an earlier one. */
  readonly files: readonly EnvFileContribution[];
  /** The `env.files` entries in force: the marker's, else the defaults. Empty
   *  when `failed` is set. */
  readonly entries: readonly EnvFileEntry[];
  readonly unreadable: readonly UnreadableEnvFile[];
  /** The marker found, if any. */
  readonly marker?: string;
  /** What the marker got wrong. Anything outside `env:` is survivable. */
  readonly diagnostics: readonly WorkspaceDiagnostic[];
  /** Set when the marker's `env:` could not be read — or the marker itself —
   *  so the host must refuse rather than resolve against a guessed bound. */
  readonly failed?: string;
}

/** Collect the env files visible from `start`, through `read`. */
export async function resolveWorkspaceEnv(options: ResolveWorkspaceEnvOptions): Promise<WorkspaceEnvResolution> {
  const start = workspacePath(options.start);
  const ceiling = options.ceiling === undefined ? undefined : workspacePath(options.ceiling);
  if (ceiling !== undefined && !isWithinWorkspacePath(start, ceiling)) {
    throw new Error(`The env walk starts at '${start}', which is outside its ceiling '${ceiling}'.`);
  }

  const found = await findMarker(start, ceiling, options.read);
  const empty = { values: {}, sources: {}, files: [], unreadable: [] };
  if (found?.read.kind === "unreadable") {
    const message =
      `${found.path} could not be read (${found.read.reason}). It bounds which env files may be ` +
      `read, so its contents cannot be assumed.`;
    return {
      ...empty,
      entries: [],
      marker: found.path,
      diagnostics: [{ code: "WORKSPACE_INVALID_VALUE", severity: "error", message, path: [] }],
      failed: message,
    };
  }

  const marker = found?.read.kind === "text" ? readWorkspaceConfig(found.read.text, WORKSPACE_FILENAME) : undefined;
  const diagnostics = marker?.diagnostics ?? [];
  const envErrors = diagnosticsFor(diagnostics, "env");
  if (hasError(envErrors)) {
    return {
      ...empty,
      entries: [],
      ...(found ? { marker: found.path } : {}),
      diagnostics,
      failed: envErrors.find((diagnostic) => diagnostic.severity === "error")!.message,
    };
  }

  const entries = marker?.config.env?.files ?? DEFAULT_ENV_FILES;
  const values: Record<string, string> = {};
  const sources: Record<string, string> = {};
  const files: EnvFileContribution[] = [];
  const unreadable: UnreadableEnvFile[] = [];
  const directories = found ? walk(start, found.directory, marker?.config.env?.roots) : [start];
  for (const directory of directories.reverse()) {
    for (const entry of entries) {
      const path = workspacePathJoin(directory, entry.name);
      const read = await options.read(path);
      if (read.kind === "missing") continue;
      if (read.kind !== "text") {
        unreadable.push({ path, reason: read.kind === "unreadable" ? read.reason : "not a file" });
        continue;
      }
      files.push({ path, sensitive: entry.sensitive });
      for (const [key, value] of Object.entries(envFileValues(read.text))) {
        values[key] = value;
        sources[key] = path;
      }
    }
  }
  return {
    values,
    sources,
    files,
    entries,
    unreadable,
    ...(found ? { marker: found.path } : {}),
    diagnostics,
  };
}

interface FoundMarker {
  readonly directory: string;
  readonly path: string;
  readonly read: EnvFileRead;
}

/**
 * The nearest marker at or above `start`, no higher than `ceiling`. A path
 * holding something other than a file is no marker — the kernel's finder reads
 * it the same way — while a file that cannot be read is one, and is returned so
 * the caller refuses.
 */
async function findMarker(start: string, ceiling: string | undefined, read: ReadEnvFile): Promise<FoundMarker | undefined> {
  for (let directory: string | undefined = start; directory !== undefined; directory = workspacePathParent(directory)) {
    const path = workspacePathJoin(directory, WORKSPACE_FILENAME);
    const found = await read(path);
    if (found.kind === "text" || found.kind === "unreadable") return { directory, path, read: found };
    if (directory === ceiling) return undefined;
  }
  return undefined;
}

/**
 * The start directory, then each ancestor up to and including the bound — the
 * nearest ancestor matching `env.roots`, else the marker's directory. Two
 * `roots` matches need no refusal: two bounds differ only in tightness, and the
 * nearest is the answer.
 */
function walk(start: string, root: string, roots: readonly string[] | undefined): string[] {
  const directories: string[] = [];
  for (let directory: string | undefined = start; directory !== undefined; directory = workspacePathParent(directory)) {
    directories.push(directory);
    if (directory === root) break;
    if (roots?.length && matchesPatterns(workspacePathRelative(root, directory), roots, lastMatchIndex)) break;
  }
  return directories;
}
