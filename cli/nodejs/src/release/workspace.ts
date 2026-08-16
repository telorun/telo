/**
 * Finding the workspace, and the modules inside it.
 *
 * The Node half of `telo-workspace.yaml`: walking up from the cwd to find the
 * marker, and filtering its named subtrees down to actual modules. Parsing the
 * marker is the analyzer's (`release/workspace-config.ts`), so the editor reads
 * the same file the same way.
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
 * manifest simply is not one, which is how `apps/hub-web` and `apps/telo-editor`
 * fall out.
 */

import {
  DEFAULT_MANIFEST_FILENAME,
  WORKSPACE_FILENAME,
  normalizeModuleKey,
  parseWorkspaceConfig,
  readManifestVersion,
  type ArtifactKind,
  type ModuleKey,
  type WorkspaceConfig,
} from "@telorun/analyzer";
import { GLOB_PRUNE_DIRS, selectByPatterns } from "@telorun/glob";
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
}

export interface Workspace {
  /** Absolute path of the directory holding `telo-workspace.yaml` — the anchor
   *  every key, ledger entry and fragment path is relative to. */
  readonly root: string;
  readonly config: WorkspaceConfig;
  readonly modules: readonly DiscoveredModule[];
}

export class WorkspaceNotFoundError extends Error {}

/** Walk up from `from` looking for the marker. Returns the directory holding
 *  it, or `undefined` — the file is optional, and only `telo release` requires
 *  one. */
export function findWorkspaceRoot(from: string): string | undefined {
  let dir = path.resolve(from);
  for (;;) {
    if (fs.existsSync(path.join(dir, WORKSPACE_FILENAME))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

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
        `the subtrees that hold modules:\n\n  modules:\n    - modules/*\n    - apps/*\n`,
    );
  }
  const file = path.join(root, WORKSPACE_FILENAME);
  const config = parseWorkspaceConfig(fs.readFileSync(file, "utf8"), WORKSPACE_FILENAME);
  return { root, config, modules: discoverModules(root, config) };
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
function discoverModules(root: string, config: WorkspaceConfig): DiscoveredModule[] {
  const candidates = findManifestDirs(root);
  const matched = new Set(
    selectByPatterns(candidates, [...config.modules], { applyDefaultIgnore: false }),
  );

  const modules: DiscoveredModule[] = [];
  for (const key of [...matched].sort()) {
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
        : ` Modules are discovered under ${workspace.config.modules.join(", ")}.`),
  );
}
