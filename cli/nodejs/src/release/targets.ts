/**
 * Where each module publishes, resolved.
 *
 * The cascade is per module, because a workspace may declare a base per subtree:
 * the entry's `registry:` → the `release:` block's → `--registry` →
 * `TELO_OCI_REGISTRY` → the base that module's own ledger entry recorded.
 *
 * **The ledger is last, and that is a change.** It used to win over the flag and
 * the variable, and a disagreement threw before any evidence was collected. A
 * workspace that authors its destination has said where it publishes, and a
 * cache of a past answer must not outrank it — so the ledger keeps its rung as a
 * record for a workspace that authors nothing, and a disagreement between the
 * two is reported per module by the planner rather than aborting the run.
 *
 * **This is the one destination resolver.** The release plan's import graph and
 * payloads, `telo release order`, `telo release imports` and `telo publish` all
 * read a module's destination from it — a sibling's included, through
 * `assigned` — so the ref an artifact writes for a dependency is the destination
 * that dependency is pushed to, whatever directory depth and base each sits at.
 */

import {
  checkDestinationCollisions,
  type Ledger,
  type ModuleKey,
  type ReleaseDiagnostic,
} from "@telorun/analyzer";
import * as path from "node:path";
import type { AssignedDestinations, ModulePayloadBuilder } from "../bundle/module-payload.js";
import { isInside } from "../bundle/nested-libraries.js";
import type { ModuleTarget } from "./evidence.js";
import { workspaceImports } from "./floor-propagation.js";
import { readLedger } from "./ledger-store.js";
import { releaseWorkspaceAt, type DiscoveredModule, type Workspace } from "./workspace.js";

export interface RegistryRungs {
  /** `--registry`. */
  readonly flag?: string;
  /** `TELO_OCI_REGISTRY`. */
  readonly env?: string;
}

export interface ResolvedTargets {
  readonly targets: ReadonlyMap<ModuleKey, ModuleTarget>;
  /** The same answers by manifest, for the payload builder. */
  readonly assigned: AssignedDestinations;
  readonly diagnostics: readonly ReleaseDiagnostic[];
}

/**
 * A module's publish destination: its registry base plus its own directory name.
 *
 * Identity is the ref, never `metadata.name` — this is the same rule the release
 * job has always applied, lifted out of a shell script. It is a policy rather
 * than a derivation: nothing in the graph can say which repo a module publishes
 * to.
 */
export function destinationFor(registry: string, module: DiscoveredModule): string {
  return `${registry.replace(/\/+$/, "")}/${path.basename(module.dir)}`;
}

export function resolveTargets(
  workspace: Workspace,
  ledger: Ledger,
  rungs: RegistryRungs,
): ResolvedTargets {
  const targets = new Map<ModuleKey, ModuleTarget>();
  const diagnostics: ReleaseDiagnostic[] = [];

  for (const module of workspace.modules) {
    const registry =
      module.settings.registry ?? rungs.flag ?? rungs.env ?? ledger.modules.get(module.key)?.registry;
    if (!registry) {
      diagnostics.push({
        severity: "error",
        code: "NO_DESTINATION_KNOWN",
        message:
          `${module.key} has no publish destination. Nothing has been published from it, its ` +
          `entry declares no 'registry:' and neither does the 'release:' block — so declare one ` +
          `in telo-workspace.yaml (the entry's 'registry:' or the block's 'release.registry') or set ` +
          `TELO_OCI_REGISTRY; \`telo release\` also takes --registry.`,
      });
      continue;
    }
    const base = registry.replace(/\/+$/, "");
    targets.set(module.key, { registry: base, destination: destinationFor(base, module) });
  }

  diagnostics.push(
    ...checkDestinationCollisions(
      [...targets].map(([key, target]) => ({ key, destination: target.destination })),
    ),
  );
  return { targets, assigned: assignedDestinations(workspace, targets), diagnostics };
}

/** Resolved destinations read by a module's manifest path. */
export function assignedDestinations(
  workspace: Workspace,
  targets: ReadonlyMap<ModuleKey, ModuleTarget>,
): AssignedDestinations {
  const byManifest = new Map<string, string>();
  for (const module of workspace.modules) {
    const target = targets.get(module.key);
    if (target) byManifest.set(path.resolve(module.manifestPath), target.destination);
  }
  return { destinationOf: (manifestPath) => byManifest.get(path.resolve(manifestPath)) };
}

/** A manifest `telo publish` was given, read as a module of its release
 *  workspace. */
export interface WorkspaceAssignment {
  readonly module: DiscoveredModule;
  /** Where the cascade puts it; absent when no rung names a base. */
  readonly destination: string | undefined;
  readonly assigned: AssignedDestinations;
  /** The marker's diagnostics and the cascade's that concern this module or the
   *  siblings it imports; another module's are `telo release`'s to report. */
  readonly diagnostics: readonly ReleaseDiagnostic[];
}

/**
 * The release workspace's answer for the module at `manifestPath`, or `null`
 * when it is a module of none — no marker above it, a marker with no `release:`
 * block, or a manifest that is not one of its modules — which is when `telo
 * publish` still derives a sibling's destination from the path.
 */
export function workspaceAssignment(
  manifestPath: string,
  rungs: RegistryRungs,
): WorkspaceAssignment | null {
  const workspace = releaseWorkspaceAt(path.dirname(manifestPath));
  if (!workspace) return null;
  const module = workspace.modules.find(
    (candidate) => path.resolve(candidate.manifestPath) === path.resolve(manifestPath),
  );
  if (!module) return null;
  const resolved = resolveTargets(workspace, readLedger(workspace.root), rungs);
  const concerned = importClosure(module.key, workspaceImports(workspace));
  const destinations = [...resolved.targets].map(([key, target]) => ({
    key,
    destination: target.destination,
  }));
  const concerning: ReleaseDiagnostic[] = [];
  for (const key of concerned) {
    if (!resolved.targets.has(key)) {
      const own = resolved.diagnostics.find(
        (diagnostic) => diagnostic.code === "NO_DESTINATION_KNOWN" && diagnostic.message.startsWith(`${key} `),
      );
      if (own) concerning.push(own);
    }
  }
  // A collision is about every module sharing the destination, one of which is concerned.
  const sharing = new Set(
    destinations
      .filter((entry) => concerned.has(entry.key))
      .map((entry) => entry.destination),
  );
  concerning.push(
    ...checkDestinationCollisions(destinations.filter((entry) => sharing.has(entry.destination))),
  );
  return {
    module,
    destination: resolved.targets.get(module.key)?.destination,
    assigned: resolved.assigned,
    diagnostics: [...workspace.diagnostics, ...concerning],
  };
}

/** The module and every workspace module it imports by relative path, transitively. */
function importClosure(key: ModuleKey, imports: ReadonlyMap<string, readonly string[]>): Set<ModuleKey> {
  const reached = new Set<ModuleKey>([key]);
  const queue = [key];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    for (const imported of imports.get(next) ?? []) {
      if (reached.has(imported)) continue;
      reached.add(imported);
      queue.push(imported);
    }
  }
  return reached;
}

export interface ImportGraph {
  /** In-repo modules each module imports by relative path. */
  readonly imports: ReadonlyMap<ModuleKey, readonly ModuleKey[]>;
  readonly diagnostics: readonly ReleaseDiagnostic[];
}

/**
 * The in-repo import edges, and whether each one names something publishable.
 *
 * An import inside the importer's directory ships in its artifact, so it must
 * not be a workspace module (`WORKSPACE_MODULE_NESTED`); one leaving it is
 * written as its target's assigned destination, so it must be a module the
 * workspace releases (`IMPORT_TARGET_NOT_RELEASED`).
 *
 * Reads manifest TEXT and nothing else — no payload, no claim on the shared
 * builder. Both properties are load-bearing rather than incidental: the claim is
 * what the payload builder refuses on, so a check that ran after one would never
 * be reached, and its message speaks about a manifest published to two places
 * rather than about the workspace file that said so.
 */
export async function readImportGraph(
  workspace: Workspace,
  targets: ReadonlyMap<ModuleKey, ModuleTarget>,
  builder: ModulePayloadBuilder,
): Promise<ImportGraph> {
  const byManifest = new Map(
    workspace.modules.map((module) => [path.resolve(module.manifestPath), module]),
  );
  const shown = (file: string): string =>
    path.relative(workspace.root, file).split(path.sep).join("/");
  const imports = new Map<ModuleKey, ModuleKey[]>();
  const diagnostics: ReleaseDiagnostic[] = [];

  for (const module of workspace.modules) {
    const target = targets.get(module.key);
    if (!target) {
      imports.set(module.key, []);
      continue;
    }
    const moduleDir = path.resolve(module.dir);
    const reached: ModuleKey[] = [];
    for (const entry of await builder.relativeImportsOf(module.manifestPath, target.destination)) {
      const imported = path.resolve(entry.manifestPath);
      const sibling = byManifest.get(imported);
      if (sibling?.key === module.key) continue;
      if (isInside(moduleDir, imported)) {
        if (!sibling) continue;
        reached.push(sibling.key);
        diagnostics.push({
          severity: "error",
          code: "WORKSPACE_MODULE_NESTED",
          message:
            `${sibling.key} lies inside ${module.key}, which imports it, so it ships inside ` +
            `${module.key}'s artifact and is not released on its own — drop the ` +
            `'${shown(sibling.dir)}' entry from telo-workspace.yaml.`,
        });
        continue;
      }
      if (!sibling) {
        diagnostics.push(unreleasedImport(module, shown(imported), enclosingModule(imported, workspace)));
        continue;
      }
      reached.push(sibling.key);
    }
    imports.set(module.key, reached);
  }

  return { imports, diagnostics };
}

function unreleasedImport(
  module: DiscoveredModule,
  imported: string,
  enclosing: DiscoveredModule | undefined,
): ReleaseDiagnostic {
  return {
    severity: "error",
    code: "IMPORT_TARGET_NOT_RELEASED",
    message:
      `${module.key} imports '${imported}' by relative path. It lies outside ${module.key}, so ` +
      `publishing writes the import as the ref the workspace assigns it — but the workspace ` +
      `releases no module there` +
      (enclosing ? `: it lies inside ${enclosing.key} and ships in that module's artifact` : "") +
      `. Import a module the workspace releases, move the library inside ${module.key}, ` +
      (enclosing
        ? `or export what it offers from ${enclosing.key}.`
        : `or list its directory under release.modules in telo-workspace.yaml.`),
  };
}

/** The nearest workspace module whose directory holds `file`. */
function enclosingModule(file: string, workspace: Workspace): DiscoveredModule | undefined {
  return workspace.modules
    .filter((module) => isInside(path.resolve(module.dir), file))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
}
