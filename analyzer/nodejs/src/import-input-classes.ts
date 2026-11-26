import type { ResourceManifest } from "@telorun/sdk";
import type { Assignment } from "./configuration-dimensions.js";
import type { ConditionedExpansion } from "./conditioned-expansion.js";
import { holdsChoice } from "./key-door.js";
import { FALSE, type Condition } from "./presence-condition.js";

/** One class of the options an import's inputs hold: where it holds, a
 *  configuration inside it, and the import read whole there. */
export interface ImportInputClass {
  readonly condition: Condition;
  readonly assignment: Assignment;
  readonly manifest: ResourceManifest;
}

/**
 * The import `manifest` of `union` once per class of the options its inputs
 * hold within `within` — the union of the classes is `within` — or one class,
 * the import as it is, when none varies. Never a configuration per class of the
 * whole application: a class is a distinct reading of this import alone.
 */
export function importInputClasses(
  union: ConditionedExpansion,
  within: Condition,
  manifest: ResourceManifest,
): ImportInputClass[] {
  const { space } = union;
  if (within === FALSE) return [];
  if (!holdsChoice(manifest)) {
    return [{ condition: within, assignment: space.firstAssignment(within) as Assignment, manifest }];
  }
  const out: ImportInputClass[] = [];
  let remaining = within;
  while (remaining !== FALSE) {
    const assignment = space.firstAssignment(remaining) as Assignment;
    const projected = union.project(manifest, assignment);
    const held = space.and(remaining, projected.taken);
    if (held === FALSE) {
      throw new Error(`internal: the import '${String(manifest.metadata?.name)}' does not hold where it was read.`);
    }
    out.push({ condition: held, assignment, manifest: projected.value as ResourceManifest });
    remaining = space.and(remaining, space.not(held));
  }
  return out;
}
