/**
 * JSON encoding for values that cross a persistence boundary.
 *
 * BigInt is encoded as a tagged object rather than as a plain string, a Number,
 * or the exact digits every other JSON boundary emits: this codec has to be
 * INVERTIBLE. A replayed value must equal the freshly-produced one — including
 * its type — or at-most-once execution silently changes its answer on the second
 * call. Digits would come back as a Number (lossy past 2^53), a string would come
 * back a different type than went in.
 *
 * That is why this file reaches past `BigInt.prototype.toJSON` with
 * {@link bigIntAt} instead of inheriting the process-wide encoding: the wire wants
 * the value, a store wants the value AND its type back.
 */

import { bigIntAt } from "./bigint-json.js";

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
  return JSON.stringify(value ?? null, function (this: unknown, key, v) {
    const source = bigIntAt(this, key);
    return source === undefined ? v : { [BIGINT_TAG]: source.toString() };
  });
}

/** Inverse of {@link encodeJsonValue}; BigInt values are restored as BigInt. */
export function decodeJsonValue(text: string): unknown {
  return JSON.parse(text, (_k, v) => (isTaggedBigInt(v) ? BigInt(v[BIGINT_TAG]) : v));
}
