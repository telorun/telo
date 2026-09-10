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
 */

import {
  checkDestinationCollisions,
  checkImportDestinations,
  type ImportDestination,
  type Ledger,
  type ModuleKey,
  type ReleaseDiagnostic,
} from "@telorun/analyzer";
import * as path from "node:path";
import type { ModulePayloadBuilder } from "../bundle/module-payload.js";
import type { ModuleTarget } from "./evidence.js";
import type { DiscoveredModule, Workspace } from "./workspace.js";

export interface RegistryRungs {
  /** `--registry`. */
  readonly flag?: string;
  /** `TELO_OCI_REGISTRY`. */
  readonly env?: string;
}

export interface ResolvedTargets {
  readonly targets: ReadonlyMap<ModuleKey, ModuleTarget>;
  readonly diagnostics: readonly ReleaseDiagnostic[];
}

/**
 * A module's publish destination: its registry base plus its own directory name.
 *
 * Identity is the ref, never `metadata.name` — this is the same rule the release
 * job has always applied, lifted out of a shell script.
 *
 * This is the ROOT destination, which is a policy rather than a derivation:
 * nothing in the graph can say which repo a module publishes to. The payload
 * builder derives a SIBLING's from it instead of re-applying this rule, so the
 * ref an artifact carries and the destination its dependency is pushed to are
 * the same string by construction — and where those two answers disagree,
 * `checkImportDestinations` says so before a payload is built.
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
          `in telo-workspace.yaml, pass --registry oci://host/org, or set TELO_OCI_REGISTRY.`,
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
  return { targets, diagnostics };
}

export interface ImportGraph {
  /** In-repo modules each module imports by relative path. */
  readonly imports: ReadonlyMap<ModuleKey, readonly ModuleKey[]>;
  readonly diagnostics: readonly ReleaseDiagnostic[];
}

/**
 * The in-repo import edges, and whether every one of them agrees about where its
 * target publishes.
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
  const byDir = new Map(workspace.modules.map((module) => [path.resolve(module.dir), module]));
  const imports = new Map<ModuleKey, ModuleKey[]>();
  const edges: ImportDestination[] = [];

  for (const module of workspace.modules) {
    const target = targets.get(module.key);
    if (!target || module.artifactKind === "image") {
      imports.set(module.key, []);
      continue;
    }
    const reached: ModuleKey[] = [];
    for (const entry of await builder.relativeImportsOf(module.manifestPath, target.destination)) {
      const sibling = byDir.get(path.resolve(path.dirname(entry.manifestPath)));
      if (!sibling || sibling.key === module.key) continue;
      reached.push(sibling.key);
      const assigned = targets.get(sibling.key);
      if (assigned) {
        edges.push({
          from: module.key,
          to: sibling.key,
          derived: entry.ref,
          assigned: assigned.destination,
        });
      }
    }
    imports.set(module.key, reached);
  }

  return { imports, diagnostics: checkImportDestinations(edges) };
}
