/**
 * The workspace on disk: the marker found by walking up, its `release:` block
 * read against the host's adapters, and its units resolved against the tree.
 */

import { GLOB_PRUNE_DIRS } from "@telorun/glob";
import * as fs from "node:fs";
import * as path from "node:path";
import { AdapterRegistry, type EcosystemAdapter } from "../adapter.js";
import { WORKSPACE_FILENAME, WorkspaceConfigError, type WorkspaceDiagnostic } from "../marker-reader.js";
import type { ReleaseDiagnostic } from "../release-plan.js";
import { readReleaseMarker, requireReleaseSettings, type ReleaseSettings } from "../release-settings.js";
import { resolveUnits, type ResolvedUnit, type WorkspaceTree } from "../units.js";

/** How a host reads its marker: the release block, and every diagnostic it
 *  reports about the file, in the plan's vocabulary. */
export type MarkerRead = (
  text: string,
  context: { readonly root: string; readonly directories: readonly string[] },
) => { readonly release?: ReleaseSettings; readonly diagnostics: readonly WorkspaceDiagnostic[]; readonly extra?: readonly ReleaseDiagnostic[] };

export interface ReleaseWorkspace {
  /** Absolute path of the directory holding the marker — the anchor of every
   *  unit key, ledger entry and fragment path. */
  readonly root: string;
  readonly release: ReleaseSettings;
  readonly units: readonly ResolvedUnit[];
  readonly diagnostics: readonly ReleaseDiagnostic[];
  readonly tree: WorkspaceTree;
  readonly adapters: AdapterRegistry;
}

export class WorkspaceNotFoundError extends Error {}

/** The nearest directory at or above `from` holding the marker. */
export function findWorkspaceRoot(from: string): string | undefined {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, WORKSPACE_FILENAME))) return dir;
    if (path.dirname(dir) === dir) return undefined;
  }
}

export interface LoadOptions {
  readonly adapters: readonly EcosystemAdapter[];
  readonly ecosystemHosts?: Readonly<Record<string, string>>;
  readonly readMarker?: MarkerRead;
  /** The command a refusal tells the reader to run. */
  readonly command?: string;
}

export function loadReleaseWorkspace(from: string, options: LoadOptions): ReleaseWorkspace {
  const root = findWorkspaceRoot(from);
  if (!root) {
    throw new WorkspaceNotFoundError(
      `No ${WORKSPACE_FILENAME} found in '${path.resolve(from)}' or any parent directory. ` +
        `\`${options.command ?? "release"}\` works over a declared workspace — create one at the repo root ` +
        `listing its units:\n\n  release:\n    units:\n      - { path: packages/*, ecosystem: npm }\n`,
    );
  }
  const text = fs.readFileSync(path.join(root, WORKSPACE_FILENAME), "utf8");
  const directories = directoriesUnder(root);
  const read: ReturnType<MarkerRead> = options.readMarker
    ? options.readMarker(text, { root, directories })
    : readReleaseMarker(text, WORKSPACE_FILENAME, options.adapters, {
        ...(options.ecosystemHosts ? { ecosystemHosts: options.ecosystemHosts } : {}),
      });
  const release = requireReleaseSettings(read, WORKSPACE_FILENAME);
  const adapters = new AdapterRegistry(options.adapters);
  const tree = workspaceTree(root, directories);
  const resolution = resolveUnits(release, tree, adapters);
  return {
    root,
    release,
    units: resolution.units,
    tree,
    adapters,
    diagnostics: [
      ...(read.extra ?? []),
      ...resolution.diagnostics.map((diagnostic) => ({
        severity: diagnostic.severity,
        code: diagnostic.code,
        message: `${WORKSPACE_FILENAME}: ${diagnostic.message}`,
      })),
    ],
  };
}

export { WorkspaceConfigError };

/** Workspace-relative directories, pruned as discovery prunes. */
export function directoriesUnder(root: string): string[] {
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

export function workspaceTree(root: string, directories: readonly string[]): WorkspaceTree {
  return {
    directories: () => directories,
    filesUnder: (dir) => filesUnder(path.join(root, dir)),
    readFile: (relative) => {
      const file = path.join(root, relative);
      return fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file, "utf8") : undefined;
    },
  };
}

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (GLOB_PRUNE_DIRS.has(entry.name)) continue;
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) found.push(path.relative(dir, child).split(path.sep).join("/"));
    }
  };
  walk(dir);
  return found;
}

/** Read a workspace-relative file, `undefined` when absent. */
export function readWorkspaceFile(workspace: { readonly root: string }, relative: string): string | undefined {
  const file = path.join(workspace.root, relative);
  return fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file, "utf8") : undefined;
}
