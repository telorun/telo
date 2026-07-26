/**
 * JSON encoding for values that cross a persistence boundary.
 *
 * `JSON.stringify` THROWS on a BigInt, and CEL integers surface as BigInt in
 * this runtime — so any controller that persists a result computed in CEL
 * (`{ charged: 500 }` from a `Run.Sequence` output) hits it. A store that lets
 * that throw escape is worse than one that never persisted: the caller sees an
 * opaque TypeError, and a decorator built on the store can mistake it for the
 * body having failed.
 *
 * BigInt is encoded as a tagged object rather than a plain string or a Number:
 * a string would come back a different type than went in, and Number is lossy
 * past 2^53. A replayed value must equal the freshly-produced one, or
 * at-most-once execution silently changes its answer on the second call.
 */

const BIGINT_TAG = "$bigint";

interface TaggedBigInt {
  [BIGINT_TAG]: string;
}

function isTaggedBigInt(value: unknown): value is TaggedBigInt {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as TaggedBigInt)[BIGINT_TAG] === "string" &&
    Object.keys(value).length === 1
  );
}

/** Serialize a value to JSON text, preserving BigInt exactly. */
export function encodeJsonValue(value: unknown): string {
  return JSON.stringify(value ?? null, (_k, v) =>
    typeof v === "bigint" ? { [BIGINT_TAG]: v.toString() } : v,
  );
}

/** Inverse of {@link encodeJsonValue}; BigInt values are restored as BigInt. */
export function decodeJsonValue(text: string): unknown {
  return JSON.parse(text, (_k, v) => (isTaggedBigInt(v) ? BigInt(v[BIGINT_TAG]) : v));
}
