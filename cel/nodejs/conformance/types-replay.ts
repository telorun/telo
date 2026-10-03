/**
 * `types.json`: where the engine answers the recording about a host's own types, and where
 * it does not.
 *
 * The driver is `dialect-replay.ts`, and the type definitions themselves are its parameter
 * — no host type name is written in this package. What is written here is only the
 * positions this file needs.
 */

import type { DialectCorrectionGroup, DialectExclusionGroup } from "./dialect-replay.js";

export const TYPES_FILE = "types.json";

export const TYPES_CORRECTIONS: readonly DialectCorrectionGroup[] = [
  {
    cause: "an unresolved type parameter is reported as dyn",
    authority:
      "cel-spec types an unconstrained type variable as `dyn` wherever it is used — its own row is named `unconstrained_type_var_as_dyn` — and this engine applies that rule to the type it HANDS OUT as well, so `optional.none()` reports `optional<dyn>` and not `optional<T>`. A consumer reading `T` would have to know what the letter meant to this engine, and the answer is that nothing resolved it; a parameter survives only where it is declared, in a signature's own text. The check-level language replay records the same disagreement for the three `type_deduction/type_parameters_in_type_type` rows, under its `typeDiffers` list",
    rows: ["types/optional/none"],
  },
];

export const TYPES_EXCLUSIONS: readonly DialectExclusionGroup[] = [];
