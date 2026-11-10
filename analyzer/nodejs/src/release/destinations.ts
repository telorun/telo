/**
 * Where each module publishes, and the one way a set of destinations can be
 * inconsistent.
 *
 * A destination is the module's resolved registry base plus its own directory
 * name, and it is ASSIGNED: an import of one workspace module by another is
 * written as the target's assigned destination, so modules at different depths
 * and under different bases import each other with no rule relating their
 * paths. Path resolution against the importer's destination governs only a
 * library nested inside the importer's own directory, whose relative spelling
 * ships in the artifact.
 *
 * Checked here **at plan time, before any payload is built**, because the
 * payload builder's own refusal speaks about a manifest published to two places
 * rather than about the workspace file that said so. Pure data in, diagnostics
 * out: the destinations are already computed for `telo release order`.
 */

import type { ModuleKey } from "./fragment.js";
import type { ReleaseDiagnostic } from "./release-plan.js";

export interface ModuleDestination {
  readonly key: ModuleKey;
  /** `<registry>/<the module's own directory name>`. */
  readonly destination: string;
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
