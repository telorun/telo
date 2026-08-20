/**
 * The ambient kernel error union: codes any dispatch can raise because the
 * kernel — not the kind's controller — enforces the invocation contract.
 *
 * They are **catchable**: a `catches:` entry may name one and its `when:` is
 * validated against this set, so a typo is caught statically like any declared
 * code. They are **excluded from coverage counting**: the completeness rule
 * keeps counting only a kind's own `throws:` codes. Folding them into every
 * union instead would make every bounded `catches:` block in the standard
 * library incomplete overnight; making them uncatchable would leave an author no
 * way to handle a contract violation they can legitimately recover from.
 *
 * Shared by the kernel (which raises them), the analyzer (which type-checks
 * `catches:` against them) and module authors (who name them in a catch).
 */

/** Inputs did not satisfy the target's declared `inputType`. */
export const ERR_INPUT_INVALID = "ERR_INPUT_INVALID";

/** A result did not satisfy the target's declared `outputType`. */
export const ERR_OUTPUT_INVALID = "ERR_OUTPUT_INVALID";

/** A declared contract could not be resolved to a schema — a named type that
 *  never registered. Distinct from a value violation: nothing is wrong with the
 *  data, the contract itself is unusable, and enforcement must fail rather than
 *  quietly switch itself off. */
export const ERR_CONTRACT_UNRESOLVABLE = "ERR_CONTRACT_UNRESOLVABLE";

/** A contract slot declaring `x-telo-schema-projection-from` named a declaration
 *  that could not be projected. The same failure as {@link
 *  ERR_CONTRACT_UNRESOLVABLE} one level down: the slot promises the shape of a
 *  referenced declaration, so leaving it unprojected enforces nothing exactly
 *  where it claims to enforce something. Its own code because the repair is
 *  different — fix the reference, not the type registration. */
export const ERR_SCHEMA_PROJECTION_UNRESOLVED = "ERR_SCHEMA_PROJECTION_UNRESOLVED";

export const AMBIENT_CONTRACT_ERROR_CODES = [
  ERR_INPUT_INVALID,
  ERR_OUTPUT_INVALID,
  ERR_CONTRACT_UNRESOLVABLE,
  ERR_SCHEMA_PROJECTION_UNRESOLVED,
] as const;

export type AmbientContractErrorCode = (typeof AMBIENT_CONTRACT_ERROR_CODES)[number];

const AMBIENT = new Set<string>(AMBIENT_CONTRACT_ERROR_CODES);

/** True when a code is raised by the kernel's contract enforcement rather than
 *  declared by a kind. Callers use it to accept the code in a `catches:` entry
 *  without counting it toward that kind's declared union. */
export function isAmbientContractErrorCode(code: string): boolean {
  return AMBIENT.has(code);
}
