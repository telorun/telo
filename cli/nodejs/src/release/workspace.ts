/**
 * Finding the workspace, and the modules inside it.
 *
 * The Node half of `telo-workspace.yaml`: walking up from the cwd to find the
 * marker, and filtering the subtrees its `release.modules` names down to actual
 * modules. Finding the marker is `workspace-marker.ts`'s — its location is a
 * general anchor, not a release concept — and parsing it is the analyzer's
 * (`release/workspace-config.ts`), so the editor reads the same file the same
 * way.
 *
 * **Discovery, not registration.** Nothing lists the modules: `modules/sql` is a
 * module because `modules/sql/telo.yaml` carries a `metadata.version`, and that
 * one field is both the declaration and the current value. Changie's generated
 * `projects:` list was the alternative, and it needed a CI check to catch itself
 * drifting.
 *
 * The rule is deliberately the module DOC's version rather than any manifest in
 * the directory — the looser reading admits `apps/hub/test-suite-e2e.yaml`'s
 * `version: 1.0.0` as a second module — and a listed directory holding no
 * manifest simply is not one, which is how `apps/hub-web` and `apps/studio`
 * fall out.
 *
 * **Selection and attribution are ONE decision.** The entry list is evaluated
 * last-match-wins, so the entry that decides whether a directory is a module is
 * the same entry whose settings that module resolves — which is why this reads
 * the deciding index rather than asking for a filtered set and then guessing
 * which pattern produced it.
 */

import {
  DEFAULT_MANIFEST_FILENAME,
  WORKSPACE_FILENAME,
  normalizeModuleKey,
  readManifestVersion,
  readWorkspaceConfig,
  requireReleaseSettings,
  settingsForModule,
  type ArtifactKind,
  type ModuleKey,
  type ModuleSettings,
  type ReleaseDiagnostic,
  type ReleaseSettings,
} from "@telorun/analyzer";
import { GLOB_PRUNE_DIRS, lastMatchIndex } from "@telorun/glob";
import {
  DiagnosticSeverity,
  workspaceDiagnostics,
  type NormalizedDiagnostic,
} from "@telorun/ide-support";
import { findWorkspaceRoot } from "../workspace-marker.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseAllDocuments } from "yaml";

export interface DiscoveredModule {
  readonly key: ModuleKey;
  /** Absolute path of the module's directory. */
  readonly dir: string;
  /** Absolute path of its `telo.yaml`. */
  readonly manifestPath: string;
  /** `metadata.name`, for display. */
  readonly name: string;
  readonly version: string;
  readonly artifactKind: ArtifactKind;
  /** What the `release.modules` entry that claimed this module settles: the
   *  authored registry base (before the flag / env / ledger rungs) and the
   *  ignore list in force. */
  readonly settings: ModuleSettings;
}

export interface Workspace {
  /** Absolute path of the directory holding `telo-workspace.yaml` — the anchor
   *  every key, ledger entry and fragment path is relative to. */
  readonly root: string;
  readonly release: ReleaseSettings;
  /** What the marker itself got wrong, in the plan's own vocabulary. */
  readonly diagnostics: readonly ReleaseDiagnostic[];
  readonly modules: readonly DiscoveredModule[];
}

export class WorkspaceNotFoundError extends Error {}

/**
 * Load the workspace rooted at or above `from`.
 *
 * Absence is an actionable error naming the file to create, never a guess at the
 * layout: guessing is what the retired scripts did by hardcoding this repo's
 * `modules/*` and `apps/*` globs into a feature meant to serve any module repo.
 */
export function loadWorkspace(from: string = process.cwd()): Workspace {
  const root = findWorkspaceRoot(from);
  if (!root) {
    throw new WorkspaceNotFoundError(
      `No ${WORKSPACE_FILENAME} found in '${path.resolve(from)}' or any parent directory. ` +
        `\`telo release\` works over a declared workspace — create one at the repo root naming ` +
        `the subtrees that hold modules:\n\n  release:\n    modules:\n      - modules/*\n      - apps/*\n`,
    );
  }
  const file = path.join(root, WORKSPACE_FILENAME);
  const text = fs.readFileSync(file, "utf8");
  const read = readWorkspaceConfig(text, WORKSPACE_FILENAME);
  const release = requireReleaseSettings(read, WORKSPACE_FILENAME);
  const manifestDirs = findManifestDirs(root);
  return {
    root,
    release,
    // The repo-shaped checks run HERE, not only in the editor. They exist to
    // name the failure a four-way workspace split hid for months — an entry that
    // discovers nothing — and a check that squiggles in VS Code while CI stays
    // silent is the editor and the checker disagreeing, which is the one thing
    // this repo does not let a surface do.
    diagnostics: workspaceDiagnostics(text, {
      match: lastMatchIndex,
      moduleDirectories: () => manifestDirs,
      directories: () => directoriesUnder(root),
      enclosingMarkers: () => enclosingMarkers(root),
    }).map(asReleaseDiagnostic),
    modules: discoverModules(root, release, manifestDirs),
  };
}

/** A marker diagnostic in the vocabulary the release plan already reports in, so
 *  one printer renders both. */
function asReleaseDiagnostic(diagnostic: NormalizedDiagnostic): ReleaseDiagnostic {
  return {
    severity: diagnostic.severity === DiagnosticSeverity.Error ? "error" : "warning",
    code: diagnostic.code,
    message: `${WORKSPACE_FILENAME}: ${diagnostic.message}`,
  };
}

/** Workspace-relative directories, pruned the way discovery prunes — the same
 *  set `env.roots` patterns are matched against at run time. */
function directoriesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || GLOB_PRUNE_DIRS.has(entry.name)) continue;
      const child = path.join(dir, entry.name);
      found.push(path.relative(root, child).split(path.sep).join("/"));
      walk(child);
    }
  };
  walk(root);
  return found;
}

/** Markers above this one — each gives everything beneath it a different cache
 *  root, different module keys and a different release scope. */
function enclosingMarkers(root: string): string[] {
  const found: string[] = [];
  let dir = path.dirname(root);
  for (;;) {
    if (fs.existsSync(path.join(dir, WORKSPACE_FILENAME))) found.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

/**
 * Every directory under a named subtree that holds a versioned module manifest.
 *
 * Candidates come from a pruned walk for `telo.yaml` rather than from expanding
 * the patterns against the filesystem, because the patterns are gitignore-style
 * and a prefix is not always derivable from one. The prune set is the shared one
 * (`node_modules`, `.git`, `.telo`), which is what keeps the hundreds of cached
 * manifests under `**\/.telo/manifests/` out — each of those is a published
 * module's `telo.yaml` and would otherwise read as a module of this workspace.
 */
function discoverModules(
  root: string,
  release: ReleaseSettings,
  manifestDirs: readonly string[],
): DiscoveredModule[] {
  const modules: DiscoveredModule[] = [];
  for (const key of [...manifestDirs].sort()) {
    const settings = settingsForModule(release, key, lastMatchIndex);
    if (!settings) continue;
    const dir = path.join(root, key);
    const manifestPath = path.join(dir, DEFAULT_MANIFEST_FILENAME);
    const text = fs.readFileSync(manifestPath, "utf8");
    const version = readManifestVersion(text);
    if (!version) continue;
    modules.push({
      key: normalizeModuleKey(key),
      dir,
      manifestPath,
      name: readModuleName(text) ?? path.basename(dir),
      version,
      artifactKind: fs.existsSync(path.join(dir, "Dockerfile")) ? "image" : "registry",
      settings,
    });
  }
  return modules;
}

/** Workspace-relative directories holding a `telo.yaml`, pruned. */
function findManifestDirs(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === DEFAULT_MANIFEST_FILENAME)) {
      const rel = path.relative(root, dir).split(path.sep).join("/");
      if (rel !== "") found.push(rel);
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || GLOB_PRUNE_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name));
    }
  };
  walk(root);
  return found;
}

function readModuleName(text: string): string | undefined {
  const first = parseAllDocuments(text)[0]?.toJSON() as
    | { metadata?: { name?: unknown } }
    | undefined;
  const name = first?.metadata?.name;
  return typeof name === "string" ? name : undefined;
}

/** Look a module up by key, with a message that lists what does exist — the
 *  common mistake is a bare name (`sql`) where a path (`modules/sql`) is
 *  wanted. */
export function requireModule(workspace: Workspace, key: string): DiscoveredModule {
  const normalized = normalizeModuleKey(key);
  const found = workspace.modules.find((module) => module.key === normalized);
  if (found) return found;
  const suffixMatches = workspace.modules.filter(
    (module) => module.key.endsWith(`/${normalized}`),
  );
  throw new Error(
    `'${key}' is not a module in this workspace.` +
      (suffixMatches.length > 0
        ? ` A module is named by its workspace-relative path — did you mean ${suffixMatches
            .map((module) => `'${module.key}'`)
            .join(" or ")}?`
        : ` Modules are discovered under ${workspace.release.modules
            .map((entry) => entry.path)
            .join(", ")}.`),
  );
}
