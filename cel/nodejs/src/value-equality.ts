/**
 * Equality and ordering over values — **one comparison, serving both.**
 *
 * `<`, `<=`, `>`, `>=`, cross-numeric equality, `in` over a list and a list index all read
 * the same rule, because two readers of "is this the same value" is how a container and an
 * operator come to disagree about one expression.
 *
 * **Across the numeric types it CONVERTS.** The checker is strict — `1.0 == 1` is a type
 * error — but `dyn(1.0) == 1` checks, so the runtime is reached with two numeric types in
 * hand and cel-spec's answer is `true`. Where the double lies outside the integer type's
 * range the sign decides; otherwise the integer becomes a double and two doubles are
 * compared, **lossily**, so `dyn(9223372036854775807) < 9223372036854775808.0` is `false`.
 * That is cel-spec's own rule: its corpus comments the case ("the conversion of the int to
 * double is lossy") and names the test `not_lt_dyn_int_big_lossy_double`. `int(double)`
 * refuses a double at or beyond **either** int64 extreme for the same reason.
 *
 * An exact comparison is defensible alone and indefensible as a cross-engine contract: a
 * second engine built on a conformant library would answer the other way on a comparison
 * that can decide an authorization or a retry bound, silently, at a level no static check
 * reaches.
 *
 * **A map's key identity is NOT this comparison** and does not convert: a map is keyed by
 * the canonical text of its key, so `{1u: 1.0}[?1.0]` reads the entry and `[?3.1]` names
 * none.
 *
 * Equality across unrelated types is `false`, not an error — two values of different
 * types are not equal, and asking is not a mistake. Ordering across unrelated types has
 * no answer, so the caller reports no overload.
 */

import { durationNanos } from "./duration-value.js";
import { mapKeyIdentity } from "./cel-map-value.js";
import type { CelMapKey, CelValue } from "./cel-value.js";
import {
  celTypeNameOf,
  isCelBytes,
  isCelDuration,
  isCelMap,
  isCelOptional,
  isCelRecord,
  isCelTimestamp,
  isCelTypeValue,
  isCelUint,
} from "./cel-value.js";
import { timestampNanos } from "./timestamp-value.js";

/** The int64 and uint64 extremes as doubles. Each reads as the nearest double there is. */
const MIN_INT_AS_DOUBLE = -9223372036854775808;
const MAX_INT_AS_DOUBLE = 9223372036854775807;
const MAX_UINT_AS_DOUBLE = 18446744073709551615;

/**
 * Comparing an integer against a double, cel-spec's way: outside the integer type's range
 * the sign decides, inside it both sides are doubles. Nothing for NaN, which orders with
 * nothing including itself.
 */
function compareIntegerDouble(left: bigint, unsigned: boolean, right: number): number | undefined {
  if (Number.isNaN(right)) return undefined;
  if (right < (unsigned ? 0 : MIN_INT_AS_DOUBLE)) return 1;
  if (right > (unsigned ? MAX_UINT_AS_DOUBLE : MAX_INT_AS_DOUBLE)) return -1;
  const converted = Number(left);
  return converted < right ? -1 : converted > right ? 1 : 0;
}

function compareNumbers(left: number, right: number): number | undefined {
  if (Number.isNaN(left) || Number.isNaN(right)) return undefined;
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareBigints(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The numeric magnitude of a value, where it has one, and which range it belongs to. */
function numeric(
  value: CelValue,
): { integer: bigint; unsigned: boolean } | { double: number } | undefined {
  if (typeof value === "bigint") return { integer: value, unsigned: false };
  if (typeof value === "number") return { double: value };
  if (isCelUint(value)) return { integer: value.value, unsigned: true };
  return undefined;
}

/** Whether two numeric values compare, and how. Nothing where one is NaN. */
function compareNumeric(left: CelValue, right: CelValue): number | undefined {
  const a = numeric(left);
  const b = numeric(right);
  if (!a || !b) return undefined;
  if ("integer" in a && "integer" in b) {
    // An int and a uint are both exact integers, so one comparison serves both.
    return compareBigints(a.integer, b.integer);
  }
  if ("integer" in a) {
    return compareIntegerDouble(a.integer, a.unsigned, (b as { double: number }).double);
  }
  if ("integer" in b) {
    const compared = compareIntegerDouble(b.integer, b.unsigned, a.double);
    return compared === undefined ? undefined : -compared;
  }
  return compareNumbers(a.double, (b as { double: number }).double);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const shared = Math.min(left.length, right.length);
  for (let at = 0; at < shared; at += 1) {
    if (left[at]! !== right[at]!) return left[at]! < right[at]! ? -1 : 1;
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
}

/**
 * How two values order: `-1`, `0`, `1`, or nothing when they do not order at all —
 * unrelated types, or a NaN, which orders with nothing including itself.
 */
export function celCompare(left: CelValue, right: CelValue): number | undefined {
  if (numeric(left) && numeric(right)) return compareNumeric(left, right);
  if (typeof left === "string" && typeof right === "string") {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    return left === right ? 0 : left ? 1 : -1;
  }
  if (isCelBytes(left) && isCelBytes(right)) return compareBytes(left, right);
  if (isCelTimestamp(left) && isCelTimestamp(right)) {
    return compareBigints(timestampNanos(left), timestampNanos(right));
  }
  if (isCelDuration(left) && isCelDuration(right)) {
    return compareBigints(durationNanos(left), durationNanos(right));
  }
  return undefined;
}

/** CEL equality: by value, across the numeric types, and `false` across unrelated ones. */
export function celEqual(left: CelValue, right: CelValue): boolean {
  // One identical primitive is equal to itself, and the two edges agree: `-0 === 0` and CEL
  // says they are equal, `NaN !== NaN` and CEL says they are not — so the slow path below
  // answers NaN correctly after this check declines it.
  if (left === right && typeof left !== "object") return true;
  if (numeric(left) && numeric(right)) return compareNumeric(left, right) === 0;
  if (left === null || right === null) return left === right;
  const leftType = celTypeNameOf(left);
  if (leftType !== celTypeNameOf(right)) return false;
  switch (leftType) {
    case "bool":
    case "string":
      return left === right;
    case "bytes":
      return compareBytes(left as Uint8Array, right as Uint8Array) === 0;
    case "google.protobuf.Timestamp":
      return timestampNanos(left as never) === timestampNanos(right as never);
    case "google.protobuf.Duration":
      return durationNanos(left as never) === durationNanos(right as never);
    case "type":
      return isCelTypeValue(left) && isCelTypeValue(right) && left.name === right.name;
    case "list":
      return equalLists(left as readonly CelValue[], right as readonly CelValue[]);
    case "map":
      return equalMaps(left, right);
    case "optional":
      return equalOptionals(left, right);
    default:
      // A host's own named type: equal when the host's operator says so, which it
      // registers itself. With none registered, identity is all this engine knows.
      return left === right;
  }
}

function equalLists(left: readonly CelValue[], right: readonly CelValue[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, at) => celEqual(value, right[at]!));
}

/** Every key of a map, as the pairs equality walks. */
function mapPairs(value: CelValue): Map<CelMapKey, CelValue> | undefined {
  if (isCelMap(value)) {
    return new Map([...value.entries].map(([identity, entry]) => [identity, entry.value]));
  }
  if (isCelRecord(value)) {
    const pairs = new Map<CelMapKey, CelValue>();
    for (const key of Object.keys(value)) pairs.set(mapKeyIdentity(key)!, value[key] as CelValue);
    return pairs;
  }
  return undefined;
}

function equalMaps(left: CelValue, right: CelValue): boolean {
  const a = mapPairs(left);
  const b = mapPairs(right);
  if (!a || !b || a.size !== b.size) return false;
  for (const [identity, value] of a) {
    if (!b.has(identity)) return false;
    if (!celEqual(value, b.get(identity)!)) return false;
  }
  return true;
}

function equalOptionals(left: CelValue, right: CelValue): boolean {
  if (!isCelOptional(left) || !isCelOptional(right)) return false;
  if (left.present !== right.present) return false;
  return !left.present || celEqual(left.held as CelValue, right.held as CelValue);
}
