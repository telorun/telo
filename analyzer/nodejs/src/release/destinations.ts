/**
 * Where each module publishes, and the two ways a set of destinations can be
 * inconsistent.
 *
 * A destination is the module's resolved registry base plus its own directory
 * name. That rule held silently for as long as every module sat at one depth
 * under one base with a unique directory name; per-subtree bases remove that
 * coincidence, so both failures it was hiding become reachable and are checked
 * here — **at plan time, before any payload is built**, because the payload
 * builder's own refusal speaks about a manifest published to two places rather
 * than about the workspace file that said so.
 *
 * Pure data in, diagnostics out: the destinations are already computed for
 * `telo release order`, so one derivation feeds that payload and both checks.
 */

import type { ModuleKey } from "./fragment.js";
import type { ReleaseDiagnostic } from "./release-plan.js";

export interface ModuleDestination {
  readonly key: ModuleKey;
  /** `<registry>/<the module's own directory name>`. */
  readonly destination: string;
}

/**
 * A relative import between two workspace modules, with both answers about
 * where the target publishes.
 *
 * `derived` is what the importer's own destination yields when the import path
 * is applied to it — the transport's rule, and what ref canonicalization writes
 * into the published manifest. `assigned` is what discovery independently gives
 * that module.
 */
export interface ImportDestination {
  readonly from: ModuleKey;
  readonly to: ModuleKey;
  readonly derived: string;
  readonly assigned: string;
}

/**
 * Two modules must not resolve to one ref.
 *
 * Nothing else catches it: the payload builder is keyed by manifest, so it sees
 * one module claimed by two destinations and never two modules claiming one,
 * while the ledger keys by module — both entries would record digests for a
 * single published artifact and reconciliation could never settle.
 */
export function checkDestinationCollisions(
  destinations: readonly ModuleDestination[],
): ReleaseDiagnostic[] {
  const byDestination = new Map<string, ModuleKey[]>();
  for (const { key, destination } of destinations) {
    const sharing = byDestination.get(destination);
    if (sharing) sharing.push(key);
    else byDestination.set(destination, [key]);
  }

  const diagnostics: ReleaseDiagnostic[] = [];
  for (const [destination, keys] of byDestination) {
    if (keys.length < 2) continue;
    diagnostics.push({
      severity: "error",
      code: "DESTINATION_COLLISION",
      message:
        `${keys.sort().join(" and ")} both publish to '${destination}'. A module's ref is its ` +
        `registry base plus its own directory name, so they would overwrite one artifact and ` +
        `their ledger entries could never reconcile. Rename one directory, or give one of the ` +
        `subtrees its own 'registry:' in telo-workspace.yaml.`,
    });
  }
  return diagnostics;
}

/**
 * A relative import is valid only where the importer's derived ref for its
 * target equals the destination that module is independently assigned.
 *
 * Equal registries are necessary and not sufficient — two modules under one base
 * at different directory depths derive differently too. Making the builder take
 * the assigned destination instead is not the fix: it would put a ref in the
 * artifact that the transport's resolution rule does not produce, so the
 * manifest would say one thing and every consumer resolving relatively would
 * compute another.
 */
export function checkImportDestinations(
  edges: readonly ImportDestination[],
): ReleaseDiagnostic[] {
  const diagnostics: ReleaseDiagnostic[] = [];
  for (const edge of edges) {
    if (edge.derived === edge.assigned) continue;
    diagnostics.push({
      severity: "error",
      code: "IMPORT_DESTINATION_CONFLICT",
      message:
        `${edge.from} imports ${edge.to} by relative path, which canonicalizes to ` +
        `'${edge.derived}' — but ${edge.to} publishes to '${edge.assigned}'. Publishing rewrites ` +
        `the import to the ref its own path yields, so the artifact would name a module nobody ` +
        `pushes. Give the two the same registry base and the same directory depth, or make it a ` +
        `pinned remote import, which is what a dependency across a publish boundary is.`,
    });
  }
  return diagnostics;
}
