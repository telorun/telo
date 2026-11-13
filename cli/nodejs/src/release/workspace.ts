/**
 * Finding the workspace, and the modules inside it.
 *
 * The Node half of `telo-workspace.yaml`: walking up from the cwd to find the
 * marker, and resolving its `release.units` against the tree. Finding the
 * marker is `workspace-marker.ts`'s, parsing it the analyzer's and
 * `@telorun/release`'s, so the editor reads the same file the same way.
 *
 * A module is a unit whose entry lists the `telo` ecosystem: its anchor holds a
 * `telo.yaml` whose module doc carries a `metadata.version`. The rule is the
 * module DOC's version rather than any manifest in the directory — the looser
 * reading admits `apps/hub/test-suite-e2e.yaml`'s `version: 1.0.0` as a second
 * module. The entry that decides whether a directory is a unit is the entry
 * whose settings it resolves.
 */

import {
  DEFAULT_MANIFEST_FILENAME,
  TELO_ECOSYSTEM,
  TELO_RELEASE_ADAPTERS,
  WORKSPACE_FILENAME,
  readManifestVersion,
  readWorkspaceConfig,
} from "@telorun/analyzer";
import {
  dockerAdapter,
  normalizeUnitKey,
  type ReleaseDiagnostic,
  type ResolvedUnit,
  type UnitKey,
} from "@telorun/release";
import { loadReleaseWorkspace, type MarkerRead, type ReleaseWorkspace } from "@telorun/release/node";
import { lastMatchIndex } from "@telorun/glob";
import {
  DiagnosticSeverity,
  workspaceDiagnostics,
  type NormalizedDiagnostic,
} from "@telorun/ide-support";
import { findWorkspaceRoot } from "../workspace-marker.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseAllDocuments } from "yaml";

/** What ships a module: its own artifact alone, or — with `docker` listed beside
 *  `telo` — an image built from its directory as well. */
export type ArtifactKind = "registry" | "image";

/** What the `release.units` entry that claimed a module settles. */
export interface ModuleSettings {
  /** Index into `release.units` of the entry that decided this module. */
  readonly entry: number;
  /** The authored registry base — the module anchor's own, else
   *  `release.ecosystems.telo`'s — before the flag / env / ledger rungs. */
  readonly registry?: string;
  readonly ignore: readonly string[];
}

export interface DiscoveredModule {
  readonly key: UnitKey;
  /** Absolute path of the module's directory. */
  readonly dir: string;
  /** Absolute path of its `telo.yaml`. */
  readonly manifestPath: string;
  /** `metadata.name`, for display. */
  readonly name: string;
  readonly version: string;
  readonly artifactKind: ArtifactKind;
  readonly settings: ModuleSettings;
  /** The unit it is — its version locations among it. */
  readonly unit: ResolvedUnit;
}

/** A release workspace as a Telo host reads it: its units, and the modules
 *  among them. */
export interface Workspace extends ReleaseWorkspace {
  readonly modules: readonly DiscoveredModule[];
}

export class WorkspaceNotFoundError extends Error {}

/**
 * The marker as a Telo host reads it: the analyzer's reader (every block, the
 * `telo` ecosystem among the adapters), plus the repo-shaped checks the editor
 * runs — an entry that discovers nothing, a shadowed entry — so CI reports what
 * the editor squiggles.
 */
export const teloMarkerRead: MarkerRead = (text, { root, directories }) => {
  const read = readWorkspaceConfig(text, WORKSPACE_FILENAME);
  return {
    ...(read.config.release ? { release: read.config.release } : {}),
    diagnostics: read.diagnostics,
    extra: workspaceDiagnostics(text, {
      match: lastMatchIndex,
      directories: () => directories,
      enclosingMarkers: () => enclosingMarkers(root),
    }).map(asReleaseDiagnostic),
  };
};

/**
 * Load the workspace rooted at or above `from`.
 *
 * Absence is an actionable error naming the file to create, never a guess at the
 * layout.
 */
export function loadWorkspace(from: string = process.cwd()): Workspace {
  if (!findWorkspaceRoot(from)) {
    throw new WorkspaceNotFoundError(
      `No ${WORKSPACE_FILENAME} found in '${path.resolve(from)}' or any parent directory. ` +
        `\`telo release\` works over a declared workspace — create one at the repo root listing ` +
        `its units:\n\n  release:\n    units:\n      - { path: modules/*, ecosystem: telo }\n`,
    );
  }
  const workspace = loadReleaseWorkspace(from, {
    adapters: TELO_RELEASE_ADAPTERS,
    readMarker: teloMarkerRead,
    command: "telo release",
  });
  return { ...workspace, modules: discoverModules(workspace.root, workspace.units) };
}

/** The release workspace holding `dir`, or `null` when it is in none — no
 *  marker above it, or a marker that declares no `release:` block. */
export function releaseWorkspaceAt(dir: string): Workspace | null {
  const root = findWorkspaceRoot(dir);
  if (!root) return null;
  const marker = fs.readFileSync(path.join(root, WORKSPACE_FILENAME), "utf8");
  return readWorkspaceConfig(marker, WORKSPACE_FILENAME).config.release !== undefined
    ? loadWorkspace(root)
    : null;
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

/** The units a module is: every one anchoring the `telo` ecosystem. */
export function discoverModules(root: string, units: readonly ResolvedUnit[]): DiscoveredModule[] {
  const modules: DiscoveredModule[] = [];
  for (const unit of units) {
    const anchor = unit.anchors.find((candidate) => candidate.ecosystem === TELO_ECOSYSTEM);
    if (!anchor) continue;
    const dir = path.join(root, anchor.dir);
    const manifestPath = path.join(dir, DEFAULT_MANIFEST_FILENAME);
    const text = fs.readFileSync(manifestPath, "utf8");
    const version = readManifestVersion(text);
    if (!version) continue;
    const registry = anchor.settings.registry;
    modules.push({
      key: unit.key,
      dir,
      manifestPath,
      name: readModuleName(text) ?? path.basename(dir),
      version,
      artifactKind: unit.anchors.some((candidate) => candidate.ecosystem === dockerAdapter.ecosystem) ? "image" : "registry",
      settings: {
        entry: unit.entry.index,
        ...(typeof registry === "string" ? { registry } : {}),
        ignore: unit.ignore,
      },
      unit,
    });
  }
  return modules;
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
  const normalized = normalizeUnitKey(key);
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
        : ` Modules are the units of entries listing the telo ecosystem: ${workspace.release.units
            .filter((entry) => entry.ecosystem?.has(TELO_ECOSYSTEM))
            .map((entry) => entry.path)
            .join(", ")}.`),
  );
}
