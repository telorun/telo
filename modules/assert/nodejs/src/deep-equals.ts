/**
 * Deep equality for the JSON-shaped values Telo stages typically pass
 * around: primitives, plain objects (proto === Object.prototype or null),
 * and arrays. Non-plain objects (Date, Map, Set, RegExp, class instances)
 * are NOT structurally compared — only `Object.is`-equal instances pass.
 *
 * This is intentional: structurally comparing the empty `Object.keys()`
 * of two distinct `new Date(…)` instances would silently return true,
 * letting `Assert.Equals` pass for values that are clearly different.
 * If a consumer genuinely needs Date / Map / Set equality, they should
 * serialize first (e.g. `date.toISOString()`) and compare the strings.
 */
export function deepEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEquals(a[i], b[i])) return false;
    }
    return true;
  }

  // Refuse structural compare for non-plain objects. Identity was already
  // checked at the top; reaching here with a non-plain object means a !== b
  // and we cannot meaningfully recurse into "fields" — empty keys would
  // produce false positives.
  if (!isPlainObject(a) || !isPlainObject(b)) return false;

  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, k) || !deepEquals(ao[k], bo[k])) return false;
  }
  return true;
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
