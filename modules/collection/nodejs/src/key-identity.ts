/** Stable string identity for a CEL key tuple, used to bucket elements in
 *  GroupBy / Distinct / Join. CEL integers are BigInt (int64), which plain
 *  JSON.stringify cannot serialize. A safe-range bigint is canonicalised to a
 *  Number so it shares an id with the same numeric value arriving as a plain
 *  number (e.g. `size(x)` matching a JSON int `1`); a true int64 outside that
 *  range keeps an exact `n`-suffixed form rather than lose precision. */
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

export function keyId(values: readonly unknown[]): string {
  return JSON.stringify(values, (_key, value) => {
    if (typeof value !== "bigint") return value;
    return value >= MIN_SAFE && value <= MAX_SAFE ? Number(value) : `${value}n`;
  });
}
