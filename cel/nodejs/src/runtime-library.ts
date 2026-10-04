/**
 * What every operator and standard function **does** — once, for both backends.
 *
 * The declarations are data (`signatures/standard-library.json`); this is the behaviour
 * behind them, keyed by the same dispatch key the registry resolves on. The closure
 * backend calls through here and the emitter will too, so there is exactly one answer
 * per operation and no second copy to drift: a semantics written inside a backend is a
 * semantics each backend gets slightly wrong in its own way.
 *
 * An implementation takes its arguments **already evaluated and already free of
 * errors** — the caller carries an error-valued operand through for the short-circuit
 * rules — and returns a value, which may itself be an error value (an overflow, a
 * missing key, a pattern RE2 refuses). Its return type is not thenable, so an
 * implementation that answers asynchronously does not compile.
 */

import type {
  CelDuration,
  CelMap,
  CelOptional,
  CelTimestamp,
  CelValue,
} from "./cel-value.js";
import {
  asyncValueRefused,
  celError,
  celNone,
  celSome,
  celTypeNameOf,
  celTypeValue,
  celUint,
  isCelBytes,
  isCelDuration,
  isCelMap,
  isCelRecord,
  isCelUint,
  type CelError,
  type CelTypeValue,
} from "./cel-value.js";
import {
  celDurationFromNanos,
  durationField,
  durationNanos,
  durationOutOfRange,
  formatDuration,
  parseDuration,
  type DurationField,
} from "./duration-value.js";
import {
  intDivide,
  intModulo,
  intResult,
  uintDivide,
  uintModulo,
  uintResult,
} from "./integer-arithmetic.js";
import { MAX_UINT } from "./lexer.js";
import { celLookup } from "./member-read.js";
import { celMatches } from "./regular-expression.js";
import type { CelSignature } from "./signature.js";
import { signatureKey } from "./signature.js";
import { googleTypeNames } from "./standard-library.js";
import type { SourceRange } from "./syntax-tree.js";
import {
  celTimestamp,
  formatTimestamp,
  parseTimestamp,
  timestampField,
  timestampNanos,
  type TimestampField,
} from "./timestamp-value.js";
import { celCompare, celEqual } from "./value-equality.js";
import { bytesToText, doubleText, textToBytes } from "./value-text.js";

/** What an implementation knows about the call it is answering. */
export interface CelCallContext {
  /** The span of the call, carried into any error value it produces. */
  readonly range?: SourceRange;
}

/**
 * What an implementation IS: its call context, then its arguments **positionally**.
 *
 * The dispatch key fixes each overload's arity, so there is never a count to carry and
 * never an array to build — a call's cost is the call. `CALL_SITE_DIRECT_ARITY` is the
 * bound, and it is the widest arity any registration declares; a trailing argument an
 * overload does not take is `undefined`, which no CEL value ever is, so an absent one is
 * unambiguous. In a port the same contract is a context plus a slice.
 */
export type CelImplementation = (
  ctx: CelCallContext,
  a?: CelValue,
  b?: CelValue,
  c?: CelValue,
  d?: CelValue,
) => CelValue;

/** The widest arity a registration declares, and so the number of direct parameters. */
export const CALL_SITE_DIRECT_ARITY = 4;

// --- reading arguments the dispatcher has already typed ---------------------

// Each takes `CelValue | undefined` because a parameter list is as wide as the widest
// overload; the dispatcher has already resolved on this argument's type, so the cast is
// what reading it means.
const text = (value: CelValue | undefined): string => value as string;
const integer = (value: CelValue | undefined): bigint => value as bigint;
const unsigned = (value: CelValue | undefined): bigint => (value as { value: bigint }).value;
const double = (value: CelValue | undefined): number => value as number;
const bytes = (value: CelValue | undefined): Uint8Array => value as Uint8Array;
const list = (value: CelValue | undefined): readonly CelValue[] => value as readonly CelValue[];
const instant = (value: CelValue | undefined): CelTimestamp => value as CelTimestamp;
const span = (value: CelValue | undefined): CelDuration => value as CelDuration;
const optional = (value: CelValue | undefined): CelOptional => value as CelOptional;
/** The argument itself, where what is read of it is that the dispatcher resolved on it. */
const value = (held: CelValue | undefined): CelValue => held as CelValue;

/** The code points of text — CEL counts and indexes a string by character. */
const characters = (value: string): string[] => [...value];

// --- conversions -----------------------------------------------------------

/** The doubles at which an int64 ends in each direction: 2^63 and -2^63. */
const INT_RANGE_ABOVE = 9223372036854775808;
const INT_RANGE_BELOW = -9223372036854775808;

const DECIMAL_INT = /^[+-]?\d+$/;
const DECIMAL_UINT = /^\+?\d+$/;
const DECIMAL_DOUBLE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function conversionError(what: string, value: string, range?: SourceRange): CelError {
  return celError("invalid_conversion", `${what} cannot convert ${value}`, range);
}

/**
 * `int(double)`. A double **at or beyond either int64 extreme** is refused, which is
 * cel-spec's rule and the only one under which the two ends behave alike: the double nearest
 * `-9223372036854775808` IS that number exactly, so an engine that refuses only the positive
 * end accepts one extreme and refuses the other for no reason a reader could state.
 */
function intFromDouble(value: number, range?: SourceRange): bigint | CelError {
  if (!Number.isFinite(value)) return conversionError("int()", doubleText(value), range);
  if (value >= INT_RANGE_ABOVE || value <= INT_RANGE_BELOW) {
    return celError("numeric_overflow", `integer overflow: ${doubleText(value)}`, range);
  }
  return BigInt(Math.trunc(value));
}

function uintFromDouble(value: number, range?: SourceRange): CelValue {
  if (!Number.isFinite(value)) return conversionError("uint()", doubleText(value), range);
  const whole = BigInt(Math.trunc(value));
  if (whole < 0n || whole > MAX_UINT) {
    return celError("numeric_overflow", `unsigned integer overflow: ${whole}`, range);
  }
  return celUint(whole);
}

function doubleFromText(value: string, range?: SourceRange): CelValue {
  const trimmed = value;
  if (/^[+-]?(?:Inf|Infinity)$/.test(trimmed)) {
    return trimmed.startsWith("-") ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }
  if (trimmed === "NaN") return Number.NaN;
  if (!DECIMAL_DOUBLE.test(trimmed)) return conversionError("double()", JSON.stringify(value), range);
  return Number(trimmed);
}

const BOOL_WORDS: Readonly<Record<string, boolean>> = {
  "1": true,
  t: true,
  true: true,
  TRUE: true,
  True: true,
  "0": false,
  f: false,
  false: false,
  FALSE: false,
  False: false,
};

/** The name a type value carries. A null's type and an optional's are named apart. */
export function typeValueName(typeName: string): string {
  if (typeName === "optional") return "optional_type";
  return typeName;
}

/** The type value of any value — `type()` must answer for anything, including `dyn`. */
export function celTypeValueOf(value: CelValue, range?: SourceRange): CelTypeValue | CelError {
  const name = celTypeNameOf(value);
  if (name === undefined) {
    return celError("invalid_conversion", "this value is of no CEL type", range);
  }
  return celTypeValue(typeValueName(name));
}

// --- text and bytes --------------------------------------------------------

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Bytes as base64 with the standard alphabet and padding. */
export function base64Text(input: Uint8Array): string {
  let out = "";
  for (let at = 0; at < input.length; at += 3) {
    const a = input[at]!;
    const b = input[at + 1];
    const c = input[at + 2];
    out += BASE64[a >> 2]!;
    out += BASE64[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    out += b === undefined ? "=" : BASE64[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    out += c === undefined ? "=" : BASE64[c & 63]!;
  }
  return out;
}

function hexText(input: Uint8Array): string {
  let out = "";
  for (const byte of input) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * JSON as CEL values: an object is a map, an array a list, a number a double. Exported
 * because the function catalog's `parseJson` answers the same question, and two readings
 * of what JSON becomes would be two value domains.
 */
export function jsonAsCelValue(parsed: unknown): CelValue {
  if (parsed === null || typeof parsed === "boolean" || typeof parsed === "number" || typeof parsed === "string") {
    return parsed;
  }
  if (Array.isArray(parsed)) return parsed.map(jsonAsCelValue);
  const out: Record<string, CelValue> = Object.create(null) as Record<string, CelValue>;
  for (const [key, value] of Object.entries(parsed as object)) out[key] = jsonAsCelValue(value);
  return out;
}

/** An index into a string, bounded by its length; an out-of-range one is refused. */
function boundedIndex(at: bigint, length: number, range?: SourceRange): number | CelError {
  if (at < 0n || at > BigInt(length)) {
    return celError("invalid_argument", `index ${at} is outside the string`, range);
  }
  return Number(at);
}

/**
 * A substring by **UTF-16 code unit**, as every index-taking member of this library is and
 * as the declaration's own `spec: false` reason states — not by code point, which is how the
 * strings extension reads the same call.
 */
function substring(value: string, from: bigint, to: bigint | undefined, range?: SourceRange): CelValue {
  const start = boundedIndex(from, value.length, range);
  if (typeof start !== "number") return start;
  const end = to === undefined ? value.length : boundedIndex(to, value.length, range);
  if (typeof end !== "number") return end;
  if (start > end) {
    return celError("invalid_argument", `the substring starts at ${from} and ends at ${to}`, range);
  }
  return value.slice(start, end);
}

/**
 * `split` with a limit, as the engine being replaced answers it: a negative limit takes
 * every part, zero takes none, and a positive one keeps the remainder in the last part.
 */
function splitText(value: string, separator: string, limit?: bigint): CelValue {
  if (limit === undefined || limit < 0n) return value.split(separator);
  if (limit === 0n) return [];
  const parts = value.split(separator);
  const kept = Number(limit);
  if (parts.length <= kept) return parts;
  return [...parts.slice(0, kept - 1), parts.slice(kept - 1).join(separator)];
}

// --- the table -------------------------------------------------------------

function timestampGetter(field: TimestampField): CelImplementation {
  // One implementation under both arities: the zone is absent where the call omits it, and
  // no CEL value is `undefined`, so the absence is the argument's own answer.
  return (ctx, a, b) => timestampField(instant(a), field, b === undefined ? undefined : text(b), ctx.range);
}

function durationGetter(field: DurationField): CelImplementation {
  return (ctx, a) => durationField(span(a), field);
}

const IMPLEMENTATIONS = new Map<string, CelImplementation>([
  // conversions
  ["bool(bool)", (ctx, a) => value(a)],
  [
    "bool(string)",
    (ctx, a) => {
      const held = BOOL_WORDS[text(a)];
      return held === undefined ? conversionError("bool()", JSON.stringify(a), ctx.range) : held;
    },
  ],
  ["bytes(bytes)", (ctx, a) => value(a)],
  ["bytes(string)", (ctx, a) => textToBytes(text(a))],
  ["double(double)", (ctx, a) => value(a)],
  ["double(int)", (ctx, a) => Number(integer(a))],
  ["double(uint)", (ctx, a) => Number(unsigned(a))],
  ["double(string)", (ctx, a) => doubleFromText(text(a), ctx.range)],
  ["duration(string)", (ctx, a) => parseDuration(text(a), ctx.range)],
  ["duration(google.protobuf.Duration)", (ctx, a) => value(a)],
  ["dyn(A)", (ctx, a) => value(a)],
  ["int(int)", (ctx, a) => value(a)],
  ["int(uint)", (ctx, a) => intResult(unsigned(a), ctx.range)],
  ["int(double)", (ctx, a) => intFromDouble(double(a), ctx.range)],
  [
    "int(string)",
    (ctx, a) => {
      const written = text(a);
      if (!DECIMAL_INT.test(written)) return conversionError("int()", JSON.stringify(written), ctx.range);
      return intResult(BigInt(written), ctx.range);
    },
  ],
  ["int(google.protobuf.Timestamp)", (ctx, a) => instant(a).seconds],
  // A duration's whole seconds, truncated toward zero — no row pins it, cel-spec does.
  ["int(google.protobuf.Duration)", (ctx, a) => durationField(span(a), "getSeconds")],
  ["matches(string, string)", (ctx, a, b) => celMatches(text(a), text(b), ctx.range)],
  ["size(string)", (ctx, a) => BigInt(characters(text(a)).length)],
  ["size(bytes)", (ctx, a) => BigInt(bytes(a).length)],
  ["size(list<A>)", (ctx, a) => BigInt(list(a).length)],
  ["size(map<K, V>)", (ctx, a) => BigInt(sizeOfMap(a))],
  ["string(string)", (ctx, a) => value(a)],
  ["string(bool)", (ctx, a) => String(a)],
  ["string(int)", (ctx, a) => String(integer(a))],
  ["string(uint)", (ctx, a) => String(unsigned(a))],
  ["string(double)", (ctx, a) => doubleText(double(a))],
  ["string(bytes)", (ctx, a) => bytesToText(bytes(a), ctx.range)],
  ["string(google.protobuf.Timestamp)", (ctx, a) => formatTimestamp(instant(a))],
  ["string(google.protobuf.Duration)", (ctx, a) => formatDuration(span(a))],
  ["timestamp(string)", (ctx, a) => parseTimestamp(text(a), ctx.range)],
  ["timestamp(int)", (ctx, a) => celTimestamp(integer(a), 0, ctx.range)],
  ["timestamp(google.protobuf.Timestamp)", (ctx, a) => value(a)],
  ["uint(uint)", (ctx, a) => value(a)],
  ["uint(int)", (ctx, a) => uintResult(integer(a), ctx.range)],
  ["uint(double)", (ctx, a) => uintFromDouble(double(a), ctx.range)],
  [
    "uint(string)",
    (ctx, a) => {
      const written = text(a);
      if (!DECIMAL_UINT.test(written)) return conversionError("uint()", JSON.stringify(written), ctx.range);
      return uintResult(BigInt(written), ctx.range);
    },
  ],

  // string members
  ["string.size()", (ctx, a) => BigInt(characters(text(a)).length)],
  ["bytes.size()", (ctx, a) => BigInt(bytes(a).length)],
  ["list<A>.size()", (ctx, a) => BigInt(list(a).length)],
  ["map<K, V>.size()", (ctx, a) => BigInt(sizeOfMap(a))],
  ["string.startsWith(string)", (ctx, a, b) => text(a).startsWith(text(b))],
  ["string.endsWith(string)", (ctx, a, b) => text(a).endsWith(text(b))],
  ["string.contains(string)", (ctx, a, b) => text(a).includes(text(b))],
  ["string.matches(string)", (ctx, a, b) => celMatches(text(a), text(b), ctx.range)],
  // Named for ASCII and not limited to it — see the declaration's own `spec: false` reason.
  ["string.lowerAscii()", (ctx, a) => text(a).toLowerCase()],
  ["string.upperAscii()", (ctx, a) => text(a).toUpperCase()],
  ["string.trim()", (ctx, a) => text(a).trim()],
  ["string.indexOf(string)", (ctx, a, b) => BigInt(text(a).indexOf(text(b)))],
  [
    "string.indexOf(string, int)",
    (ctx, a, b, c) => {
      const from = boundedIndex(integer(c), text(a).length, ctx.range);
      return typeof from === "number" ? BigInt(text(a).indexOf(text(b), from)) : from;
    },
  ],
  ["string.lastIndexOf(string)", (ctx, a, b) => BigInt(text(a).lastIndexOf(text(b)))],
  [
    "string.lastIndexOf(string, int)",
    (ctx, a, b, c) => {
      const from = boundedIndex(integer(c), text(a).length, ctx.range);
      return typeof from === "number" ? BigInt(text(a).lastIndexOf(text(b), from)) : from;
    },
  ],
  ["string.substring(int)", (ctx, a, b) => substring(text(a), integer(b), undefined, ctx.range)],
  [
    "string.substring(int, int)",
    (ctx, a, b, c) => substring(text(a), integer(b), integer(c), ctx.range),
  ],
  ["string.split(string)", (ctx, a, b) => splitText(text(a), text(b))],
  ["string.split(string, int)", (ctx, a, b, c) => splitText(text(a), text(b), integer(c))],
  ["list<string>.join()", (ctx, a) => list(a).join("")],
  ["list<string>.join(string)", (ctx, a, b) => list(a).join(text(b))],

  // bytes members, each a compatibility member rather than CEL's
  ["bytes.string()", (ctx, a) => bytesToText(bytes(a), ctx.range)],
  ["bytes.hex()", (ctx, a) => hexText(bytes(a))],
  ["bytes.base64()", (ctx, a) => base64Text(bytes(a))],
  [
    "bytes.json()",
    (ctx, a) => {
      const decoded = bytesToText(bytes(a), ctx.range);
      if (typeof decoded !== "string") return decoded;
      try {
        return jsonAsCelValue(JSON.parse(decoded));
      } catch (cause) {
        return celError("invalid_conversion", `the bytes are not JSON: ${(cause as Error).message}`, ctx.range);
      }
    },
  ],
  [
    "bytes.at(int)",
    (ctx, a, b) => {
      const held = bytes(a);
      const at = integer(b);
      if (at < 0n || at >= BigInt(held.length)) {
        return celError("index_out_of_range", `index out of range: ${at}`, ctx.range);
      }
      return BigInt(held[Number(at)]!);
    },
  ],

  // arithmetic
  ["!(bool)", (ctx, a) => !(a as boolean)],
  ["-(int)", (ctx, a) => intResult(-integer(a), ctx.range)],
  ["-(double)", (ctx, a) => -double(a)],
  ["+(int, int)", (ctx, a, b) => intResult(integer(a) + integer(b), ctx.range)],
  ["+(uint, uint)", (ctx, a, b) => uintResult(unsigned(a) + unsigned(b), ctx.range)],
  ["+(double, double)", (ctx, a, b) => double(a) + double(b)],
  ["+(string, string)", (ctx, a, b) => text(a) + text(b)],
  [
    "+(bytes, bytes)",
    (ctx, a, b) => {
      const left = bytes(a);
      const right = bytes(b);
      const out = new Uint8Array(left.length + right.length);
      out.set(left);
      out.set(right, left.length);
      return out;
    },
  ],
  ["+(list<A>, list<A>)", (ctx, a, b) => [...list(a), ...list(b)]],
  [
    "+(google.protobuf.Timestamp, google.protobuf.Duration)",
    (ctx, a, b) =>
      durationOutOfRange(span(b), ctx.range) ??
      celTimestamp(0n, timestampNanos(instant(a)) + durationNanos(span(b)), ctx.range),
  ],
  [
    "+(google.protobuf.Duration, google.protobuf.Timestamp)",
    (ctx, a, b) =>
      durationOutOfRange(span(a), ctx.range) ??
      celTimestamp(0n, durationNanos(span(a)) + timestampNanos(instant(b)), ctx.range),
  ],
  [
    "+(google.protobuf.Duration, google.protobuf.Duration)",
    (ctx, a, b) => celDurationFromNanos(durationNanos(span(a)) + durationNanos(span(b)), ctx.range),
  ],
  ["-(int, int)", (ctx, a, b) => intResult(integer(a) - integer(b), ctx.range)],
  ["-(uint, uint)", (ctx, a, b) => uintResult(unsigned(a) - unsigned(b), ctx.range)],
  ["-(double, double)", (ctx, a, b) => double(a) - double(b)],
  [
    "-(google.protobuf.Timestamp, google.protobuf.Timestamp)",
    (ctx, a, b) =>
      celDurationFromNanos(timestampNanos(instant(a)) - timestampNanos(instant(b)), ctx.range),
  ],
  [
    "-(google.protobuf.Timestamp, google.protobuf.Duration)",
    (ctx, a, b) =>
      durationOutOfRange(span(b), ctx.range) ??
      celTimestamp(0n, timestampNanos(instant(a)) - durationNanos(span(b)), ctx.range),
  ],
  [
    "-(google.protobuf.Duration, google.protobuf.Duration)",
    (ctx, a, b) => celDurationFromNanos(durationNanos(span(a)) - durationNanos(span(b)), ctx.range),
  ],
  ["*(int, int)", (ctx, a, b) => intResult(integer(a) * integer(b), ctx.range)],
  ["*(uint, uint)", (ctx, a, b) => uintResult(unsigned(a) * unsigned(b), ctx.range)],
  ["*(double, double)", (ctx, a, b) => double(a) * double(b)],
  ["/(int, int)", (ctx, a, b) => intDivide(integer(a), integer(b), ctx.range)],
  ["/(uint, uint)", (ctx, a, b) => uintDivide(unsigned(a), unsigned(b), ctx.range)],
  // A double divided by zero is an infinity, as IEEE 754 says; only the integers refuse.
  ["/(double, double)", (ctx, a, b) => double(a) / double(b)],
  ["%(int, int)", (ctx, a, b) => intModulo(integer(a), integer(b), ctx.range)],
  ["%(uint, uint)", (ctx, a, b) => uintModulo(unsigned(a), unsigned(b), ctx.range)],
  [
    "in(A, list<A>)",
    (ctx, a, b) => {
      // Membership reads every element, so an element that must be awaited is a door too, and
      // the refusal is TERMINAL as it is in a comprehension: answering `true` off the one
      // element that is readable decides the question against a list this engine cannot read.
      for (const held of list(b)) {
        const refused = asyncValueRefused(held);
        if (refused) return refused;
        if (celEqual(held, value(a))) return true;
      }
      return false;
    },
  ],
  ["in(K, map<K, V>)", (ctx, a, b) => typeof celLookup(value(b), value(a)) !== "symbol"],

  // the optional library
  ["optional<A>.hasValue()", (ctx, a) => optional(a).present],
  [
    "optional<A>.value()",
    (ctx, a) => {
      const held = optional(a);
      return held.present
        ? (held.held as CelValue)
        : celError("optional_value_missing", "the optional holds no value", ctx.range);
    },
  ],
  ["optional<A>.or(optional<A>)", (ctx, a, b) => (optional(a).present ? value(a) : value(b))],
  [
    "optional<A>.orValue(A)",
    (ctx, a, b) => (optional(a).present ? (optional(a).held as CelValue) : value(b)),
  ],

  // timestamp and duration fields
  ["google.protobuf.Timestamp.getDate()", timestampGetter("getDate")],
  ["google.protobuf.Timestamp.getDate(string)", timestampGetter("getDate")],
  ["google.protobuf.Timestamp.getDayOfMonth()", timestampGetter("getDayOfMonth")],
  ["google.protobuf.Timestamp.getDayOfMonth(string)", timestampGetter("getDayOfMonth")],
  ["google.protobuf.Timestamp.getDayOfWeek()", timestampGetter("getDayOfWeek")],
  ["google.protobuf.Timestamp.getDayOfWeek(string)", timestampGetter("getDayOfWeek")],
  ["google.protobuf.Timestamp.getDayOfYear()", timestampGetter("getDayOfYear")],
  ["google.protobuf.Timestamp.getDayOfYear(string)", timestampGetter("getDayOfYear")],
  ["google.protobuf.Timestamp.getFullYear()", timestampGetter("getFullYear")],
  ["google.protobuf.Timestamp.getFullYear(string)", timestampGetter("getFullYear")],
  ["google.protobuf.Timestamp.getHours()", timestampGetter("getHours")],
  ["google.protobuf.Timestamp.getHours(string)", timestampGetter("getHours")],
  ["google.protobuf.Timestamp.getMilliseconds()", timestampGetter("getMilliseconds")],
  ["google.protobuf.Timestamp.getMilliseconds(string)", timestampGetter("getMilliseconds")],
  ["google.protobuf.Timestamp.getMinutes()", timestampGetter("getMinutes")],
  ["google.protobuf.Timestamp.getMinutes(string)", timestampGetter("getMinutes")],
  ["google.protobuf.Timestamp.getMonth()", timestampGetter("getMonth")],
  ["google.protobuf.Timestamp.getMonth(string)", timestampGetter("getMonth")],
  ["google.protobuf.Timestamp.getSeconds()", timestampGetter("getSeconds")],
  ["google.protobuf.Timestamp.getSeconds(string)", timestampGetter("getSeconds")],
  ["google.protobuf.Duration.getHours()", durationGetter("getHours")],
  ["google.protobuf.Duration.getMinutes()", durationGetter("getMinutes")],
  ["google.protobuf.Duration.getSeconds()", durationGetter("getSeconds")],
  ["google.protobuf.Duration.getMilliseconds()", durationGetter("getMilliseconds")],
]);

function sizeOfMap(value: CelValue | undefined): number {
  if (isCelMap(value)) return (value as CelMap).entries.size;
  if (isCelRecord(value)) return Object.keys(value).length;
  return 0;
}

/**
 * Equality and ordering are answered by **name**, over every type pair the library
 * declares and every one a host adds: writing them per pair would be 40 entries that
 * all call the same two functions, and a host registering a comparison over its own type
 * would then have no implementation.
 */
const BY_NAME = new Map<string, CelImplementation>([
  ["==", (ctx, a, b) => celEqual(value(a), value(b))],
  ["!=", (ctx, a, b) => !celEqual(value(a), value(b))],
  ["<", ordering((compared) => compared < 0)],
  ["<=", ordering((compared) => compared <= 0)],
  [">", ordering((compared) => compared > 0)],
  [">=", ordering((compared) => compared >= 0)],
  ["type", (ctx, a) => celTypeValueOf(value(a), ctx.range)],
]);

function ordering(holds: (compared: number) => boolean): CelImplementation {
  return (ctx, a, b) => {
    const compared = celCompare(value(a), value(b));
    // Values that do not order at all — unrelated types, or a NaN. NaN orders with
    // nothing, including itself, so every comparison against it is false.
    if (compared === undefined) {
      if (isNotANumber(a) || isNotANumber(b)) return false;
      return celError(
        "no_matching_overload",
        `${celTypeNameOf(a) ?? "this value"} and ${celTypeNameOf(b) ?? "this value"} do not order`,
        ctx.range,
      );
    }
    return holds(compared);
  };
}

function isNotANumber(value: CelValue | undefined): boolean {
  return typeof value === "number" && Number.isNaN(value);
}

/**
 * The implementation of a registered signature, or nothing where the registration has
 * none — a host's own function, which the host supplies itself.
 */
export function implementationOf(signature: CelSignature): CelImplementation | undefined {
  return IMPLEMENTATIONS.get(signatureKey(signature)) ?? BY_NAME.get(signature.name);
}

/** Every dispatch key this file answers for, for a completeness check. */
export function implementedKeys(): readonly string[] {
  return [...IMPLEMENTATIONS.keys()];
}

/**
 * The values the library's own constants read as: each type name as a type value, and
 * `google`, through which the two well-known type names are reached — the only spelling
 * in which an expression can name the timestamp or duration type.
 */
export function standardConstantValues(optionalTypes: boolean): ReadonlyMap<string, CelValue> {
  const values = new Map<string, CelValue>();
  for (const name of ["bool", "bytes", "double", "int", "list", "map", "null_type", "string", "type", "uint"]) {
    values.set(name, celTypeValue(name));
  }
  if (optionalTypes) values.set("optional_type", celTypeValue("optional_type"));
  const google: Record<string, CelValue> = {};
  for (const [namespace, names] of googleTypeNames()) {
    const held: Record<string, CelValue> = {};
    for (const name of names) held[name] = celTypeValue(`google.${namespace}.${name}`);
    google[namespace] = held;
  }
  values.set("google", google);
  return values;
}

/**
 * `optional.ofNonZeroValue(v)`: present unless the value is its type's zero — which is
 * what makes it different from `optional.of`, and what three of the vectors' rows read.
 */
export function optionalOfNonZero(held: CelValue): CelOptional {
  return isZeroValue(held) ? celNone() : celSome(held);
}

/**
 * Whether a value is its type's zero. Every type that HAS one is listed; the types left out
 * are left out as a decision, not an omission — **an instant, a type value, an optional and
 * a host's named type have no zero in CEL**, because nothing in the language names one. An
 * engine that picked the epoch as a timestamp's zero would make
 * `optional.ofNonZeroValue(timestamp(0))` absent, which no row and no rule asks for.
 */
function isZeroValue(value: CelValue | undefined): boolean {
  if (value === null || value === false || value === "") return true;
  if (typeof value === "bigint") return value === 0n;
  if (typeof value === "number") return value === 0;
  if (isCelUint(value)) return value.value === 0n;
  if (isCelBytes(value)) return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (isCelMap(value)) return value.entries.size === 0;
  if (isCelRecord(value)) return Object.keys(value).length === 0;
  if (isCelDuration(value)) return durationNanos(value) === 0n;
  return false;
}
