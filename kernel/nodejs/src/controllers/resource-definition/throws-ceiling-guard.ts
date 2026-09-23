import {
  codesOutsideCeiling,
  throwsNotSubstitutableMessage,
  type DefResolver,
} from "@telorun/analyzer";
import type { ResourceDefinition } from "@telorun/sdk";
import { RuntimeError } from "@telorun/sdk";

/**
 * Refuse a definition declaring a throw code its nearest `throws:`-declaring
 * ancestor does not — the analyzer's rule (`THROWS_NOT_SUBSTITUTABLE`), read
 * rather than restated. Enforced here for a dependency's kind too, which the
 * entry-scoped `telo check` of a consumer never reaches. Rule 9 then makes the
 * chain transitive at dispatch: a thrown code must be in the implementation's
 * own list, and that list is inside the ceiling.
 */
export function refuseThrowsOutsideCeiling(def: ResourceDefinition, resolveDef: DefResolver): void {
  const violation = codesOutsideCeiling(def, resolveDef);
  if (violation) {
    throw new RuntimeError("ERR_THROWS_NOT_SUBSTITUTABLE", throwsNotSubstitutableMessage(def, violation));
  }
}
