/** Stable string identity for a CEL key tuple, used to bucket elements in
 *  GroupBy / Distinct / Join. CEL integers are BigInt (int64) and serialize as
 *  their exact decimal digits (see `enableBigIntJson` in `@telorun/sdk`), so a
 *  `size()`-derived key shares an id with the same numeric value arriving as a
 *  plain JSON int, and two distinct int64s never collide. */
export function keyId(values: readonly unknown[]): string {
  return JSON.stringify(values);
}
