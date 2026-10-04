/**
 * `types.json`: where the engine answers the recording about a host's own types, and where
 * it does not.
 *
 * The driver is `dialect-replay.ts`, and the type definitions themselves are its parameter
 * — no host type name is written in this package. What is written here is only the
 * positions this file needs.
 *
 * **The `presence_*` rows are this engine's own answer, authored rather than recorded.**
 * They pin what a presence-shaped read — `.?`, `[?]`, `has()` — answers over every value
 * that holds no members: absence at evaluation, and a `CEL_TYPE_ERROR` at check wherever
 * the operand's type is KNOWN to hold none, the `dyn` rows being the one place the
 * question reaches the runtime. The authority is the optional library's, which this engine
 * takes from cel-go whole: cel-go's attribute qualification answers "not found" for a
 * receiver that is neither a mapper, a lister nor an indexer **whenever the read is a
 * presence test**, and erroring instead is an explicitly named opt-in
 * (`EnableErrorOnBadPresenceTest`) that Telo does not carry. The rows beside them record
 * the two readings that are NOT loosened: the ordinary read of such a member
 * (`types/dyn/ordinary_read`, `types/optional/ordinary_read_over_scalar`) and an unusable
 * key in the presence form (`types/list/presence_unusable_key`).
 */

import type { DialectCorrectionGroup, DialectExclusionGroup } from "./dialect-replay.js";

export const TYPES_FILE = "types.json";

/** How many rows the file holds, pinned as `CATALOG_ROWS` is and for the same reason. */
export const TYPES_ROWS = 64;

export const TYPES_CORRECTIONS: readonly DialectCorrectionGroup[] = [
  {
    cause: "an unresolved type parameter is reported as dyn",
    authority:
      "cel-spec types an unconstrained type variable as `dyn` wherever it is used — its own row is named `unconstrained_type_var_as_dyn` — and this engine applies that rule to the type it HANDS OUT as well, so `optional.none()` reports `optional<dyn>` and not `optional<T>`. A consumer reading `T` would have to know what the letter meant to this engine, and the answer is that nothing resolved it; a parameter survives only where it is declared, in a signature's own text. The check-level language replay records the same disagreement for the three `type_deduction/type_parameters_in_type_type` rows, under its `typeDiffers` list",
    rows: ["types/optional/none"],
  },
];

export const TYPES_EXCLUSIONS: readonly DialectExclusionGroup[] = [];
