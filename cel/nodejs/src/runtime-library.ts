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

export type CelImplementation = (args: readonly CelValue[], ctx: CelCallContext) => CelValue;

// --- reading arguments the dispatcher has already typed ---------------------

const text = (value: CelValue): string => value as string;
const integer = (value: CelValue): bigint => value as bigint;
const unsigned = (value: CelValue): bigint => (value as { value: bigint }).value;
const double = (value: CelValue): number => value as number;
const bytes = (value: CelValue): Uint8Array => value as Uint8Array;
const list = (value: CelValue): readonly CelValue[] => value as readonly CelValue[];
const instant = (value: CelValue): CelTimestamp => value as CelTimestamp;
const span = (value: CelValue): CelDuration => value as CelDuration;
const optional = (value: CelValue): CelOptional => value as CelOptional;

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

function base64Text(input: Uint8Array): string {
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

/** JSON as CEL values: an object is a map, an array a list, a number a double. */
function jsonValue(parsed: unknown): CelValue {
  if (parsed === null || typeof parsed === "boolean" || typeof parsed === "number" || typeof parsed === "string") {
    return parsed;
  }
  if (Array.isArray(parsed)) return parsed.map(jsonValue);
  const out: Record<string, CelValue> = Object.create(null) as Record<string, CelValue>;
  for (const [key, value] of Object.entries(parsed as object)) out[key] = jsonValue(value);
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
  return (args, ctx) =>
    timestampField(instant(args[0]!), field, args.length > 1 ? text(args[1]!) : undefined, ctx.range);
}

function durationGetter(field: DurationField): CelImplementation {
  return (args) => durationField(span(args[0]!), field);
}

const IMPLEMENTATIONS = new Map<string, CelImplementation>([
  // conversions
  ["bool(bool)", (args) => args[0]!],
  [
    "bool(string)",
    (args, ctx) => {
      const held = BOOL_WORDS[text(args[0]!)];
      return held === undefined ? conversionError("bool()", JSON.stringify(args[0]), ctx.range) : held;
    },
  ],
  ["bytes(bytes)", (args) => args[0]!],
  ["bytes(string)", (args) => textToBytes(text(args[0]!))],
  ["double(double)", (args) => args[0]!],
  ["double(int)", (args) => Number(integer(args[0]!))],
  ["double(uint)", (args) => Number(unsigned(args[0]!))],
  ["double(string)", (args, ctx) => doubleFromText(text(args[0]!), ctx.range)],
  ["duration(string)", (args, ctx) => parseDuration(text(args[0]!), ctx.range)],
  ["duration(google.protobuf.Duration)", (args) => args[0]!],
  ["dyn(A)", (args) => args[0]!],
  ["int(int)", (args) => args[0]!],
  ["int(uint)", (args, ctx) => intResult(unsigned(args[0]!), ctx.range)],
  ["int(double)", (args, ctx) => intFromDouble(double(args[0]!), ctx.range)],
  [
    "int(string)",
    (args, ctx) => {
      const written = text(args[0]!);
      if (!DECIMAL_INT.test(written)) return conversionError("int()", JSON.stringify(written), ctx.range);
      return intResult(BigInt(written), ctx.range);
    },
  ],
  ["int(google.protobuf.Timestamp)", (args) => instant(args[0]!).seconds],
  // A duration's whole seconds, truncated toward zero — no row pins it, cel-spec does.
  ["int(google.protobuf.Duration)", (args) => durationField(span(args[0]!), "getSeconds")],
  ["matches(string, string)", (args, ctx) => celMatches(text(args[0]!), text(args[1]!), ctx.range)],
  ["size(string)", (args) => BigInt(characters(text(args[0]!)).length)],
  ["size(bytes)", (args) => BigInt(bytes(args[0]!).length)],
  ["size(list<A>)", (args) => BigInt(list(args[0]!).length)],
  ["size(map<K, V>)", (args) => BigInt(sizeOfMap(args[0]!))],
  ["string(string)", (args) => args[0]!],
  ["string(bool)", (args) => String(args[0]!)],
  ["string(int)", (args) => String(integer(args[0]!))],
  ["string(uint)", (args) => String(unsigned(args[0]!))],
  ["string(double)", (args) => doubleText(double(args[0]!))],
  ["string(bytes)", (args, ctx) => bytesToText(bytes(args[0]!), ctx.range)],
  ["string(google.protobuf.Timestamp)", (args) => formatTimestamp(instant(args[0]!))],
  ["string(google.protobuf.Duration)", (args) => formatDuration(span(args[0]!))],
  ["timestamp(string)", (args, ctx) => parseTimestamp(text(args[0]!), ctx.range)],
  ["timestamp(int)", (args, ctx) => celTimestamp(integer(args[0]!), 0, ctx.range)],
  ["timestamp(google.protobuf.Timestamp)", (args) => args[0]!],
  ["uint(uint)", (args) => args[0]!],
  ["uint(int)", (args, ctx) => uintResult(integer(args[0]!), ctx.range)],
  ["uint(double)", (args, ctx) => uintFromDouble(double(args[0]!), ctx.range)],
  [
    "uint(string)",
    (args, ctx) => {
      const written = text(args[0]!);
      if (!DECIMAL_UINT.test(written)) return conversionError("uint()", JSON.stringify(written), ctx.range);
      return uintResult(BigInt(written), ctx.range);
    },
  ],

  // string members
  ["string.size()", (args) => BigInt(characters(text(args[0]!)).length)],
  ["bytes.size()", (args) => BigInt(bytes(args[0]!).length)],
  ["list<A>.size()", (args) => BigInt(list(args[0]!).length)],
  ["map<K, V>.size()", (args) => BigInt(sizeOfMap(args[0]!))],
  ["string.startsWith(string)", (args) => text(args[0]!).startsWith(text(args[1]!))],
  ["string.endsWith(string)", (args) => text(args[0]!).endsWith(text(args[1]!))],
  ["string.contains(string)", (args) => text(args[0]!).includes(text(args[1]!))],
  ["string.matches(string)", (args, ctx) => celMatches(text(args[0]!), text(args[1]!), ctx.range)],
  // Named for ASCII and not limited to it — see the declaration's own `spec: false` reason.
  ["string.lowerAscii()", (args) => text(args[0]!).toLowerCase()],
  ["string.upperAscii()", (args) => text(args[0]!).toUpperCase()],
  ["string.trim()", (args) => text(args[0]!).trim()],
  ["string.indexOf(string)", (args) => BigInt(text(args[0]!).indexOf(text(args[1]!)))],
  [
    "string.indexOf(string, int)",
    (args, ctx) => {
      const from = boundedIndex(integer(args[2]!), text(args[0]!).length, ctx.range);
      return typeof from === "number" ? BigInt(text(args[0]!).indexOf(text(args[1]!), from)) : from;
    },
  ],
  ["string.lastIndexOf(string)", (args) => BigInt(text(args[0]!).lastIndexOf(text(args[1]!)))],
  [
    "string.lastIndexOf(string, int)",
    (args, ctx) => {
      const from = boundedIndex(integer(args[2]!), text(args[0]!).length, ctx.range);
      return typeof from === "number" ? BigInt(text(args[0]!).lastIndexOf(text(args[1]!), from)) : from;
    },
  ],
  ["string.substring(int)", (args, ctx) => substring(text(args[0]!), integer(args[1]!), undefined, ctx.range)],
  [
    "string.substring(int, int)",
    (args, ctx) => substring(text(args[0]!), integer(args[1]!), integer(args[2]!), ctx.range),
  ],
  ["string.split(string)", (args) => splitText(text(args[0]!), text(args[1]!))],
  ["string.split(string, int)", (args) => splitText(text(args[0]!), text(args[1]!), integer(args[2]!))],
  ["list<string>.join()", (args) => list(args[0]!).join("")],
  ["list<string>.join(string)", (args) => list(args[0]!).join(text(args[1]!))],

  // bytes members, each a compatibility member rather than CEL's
  ["bytes.string()", (args, ctx) => bytesToText(bytes(args[0]!), ctx.range)],
  ["bytes.hex()", (args) => hexText(bytes(args[0]!))],
  ["bytes.base64()", (args) => base64Text(bytes(args[0]!))],
  [
    "bytes.json()",
    (args, ctx) => {
      const decoded = bytesToText(bytes(args[0]!), ctx.range);
      if (typeof decoded !== "string") return decoded;
      try {
        return jsonValue(JSON.parse(decoded));
      } catch (cause) {
        return celError("invalid_conversion", `the bytes are not JSON: ${(cause as Error).message}`, ctx.range);
      }
    },
  ],
  [
    "bytes.at(int)",
    (args, ctx) => {
      const held = bytes(args[0]!);
      const at = integer(args[1]!);
      if (at < 0n || at >= BigInt(held.length)) {
        return celError("index_out_of_range", `index out of range: ${at}`, ctx.range);
      }
      return BigInt(held[Number(at)]!);
    },
  ],

  // arithmetic
  ["!(bool)", (args) => !(args[0] as boolean)],
  ["-(int)", (args, ctx) => intResult(-integer(args[0]!), ctx.range)],
  ["-(double)", (args) => -double(args[0]!)],
  ["+(int, int)", (args, ctx) => intResult(integer(args[0]!) + integer(args[1]!), ctx.range)],
  ["+(uint, uint)", (args, ctx) => uintResult(unsigned(args[0]!) + unsigned(args[1]!), ctx.range)],
  ["+(double, double)", (args) => double(args[0]!) + double(args[1]!)],
  ["+(string, string)", (args) => text(args[0]!) + text(args[1]!)],
  [
    "+(bytes, bytes)",
    (args) => {
      const left = bytes(args[0]!);
      const right = bytes(args[1]!);
      const out = new Uint8Array(left.length + right.length);
      out.set(left);
      out.set(right, left.length);
      return out;
    },
  ],
  ["+(list<A>, list<A>)", (args) => [...list(args[0]!), ...list(args[1]!)]],
  [
    "+(google.protobuf.Timestamp, google.protobuf.Duration)",
    (args, ctx) =>
      durationOutOfRange(span(args[1]!), ctx.range) ??
      celTimestamp(0n, timestampNanos(instant(args[0]!)) + durationNanos(span(args[1]!)), ctx.range),
  ],
  [
    "+(google.protobuf.Duration, google.protobuf.Timestamp)",
    (args, ctx) =>
      durationOutOfRange(span(args[0]!), ctx.range) ??
      celTimestamp(0n, durationNanos(span(args[0]!)) + timestampNanos(instant(args[1]!)), ctx.range),
  ],
  [
    "+(google.protobuf.Duration, google.protobuf.Duration)",
    (args, ctx) => celDurationFromNanos(durationNanos(span(args[0]!)) + durationNanos(span(args[1]!)), ctx.range),
  ],
  ["-(int, int)", (args, ctx) => intResult(integer(args[0]!) - integer(args[1]!), ctx.range)],
  ["-(uint, uint)", (args, ctx) => uintResult(unsigned(args[0]!) - unsigned(args[1]!), ctx.range)],
  ["-(double, double)", (args) => double(args[0]!) - double(args[1]!)],
  [
    "-(google.protobuf.Timestamp, google.protobuf.Timestamp)",
    (args, ctx) =>
      celDurationFromNanos(timestampNanos(instant(args[0]!)) - timestampNanos(instant(args[1]!)), ctx.range),
  ],
  [
    "-(google.protobuf.Timestamp, google.protobuf.Duration)",
    (args, ctx) =>
      durationOutOfRange(span(args[1]!), ctx.range) ??
      celTimestamp(0n, timestampNanos(instant(args[0]!)) - durationNanos(span(args[1]!)), ctx.range),
  ],
  [
    "-(google.protobuf.Duration, google.protobuf.Duration)",
    (args, ctx) => celDurationFromNanos(durationNanos(span(args[0]!)) - durationNanos(span(args[1]!)), ctx.range),
  ],
  ["*(int, int)", (args, ctx) => intResult(integer(args[0]!) * integer(args[1]!), ctx.range)],
  ["*(uint, uint)", (args, ctx) => uintResult(unsigned(args[0]!) * unsigned(args[1]!), ctx.range)],
  ["*(double, double)", (args) => double(args[0]!) * double(args[1]!)],
  ["/(int, int)", (args, ctx) => intDivide(integer(args[0]!), integer(args[1]!), ctx.range)],
  ["/(uint, uint)", (args, ctx) => uintDivide(unsigned(args[0]!), unsigned(args[1]!), ctx.range)],
  // A double divided by zero is an infinity, as IEEE 754 says; only the integers refuse.
  ["/(double, double)", (args) => double(args[0]!) / double(args[1]!)],
  ["%(int, int)", (args, ctx) => intModulo(integer(args[0]!), integer(args[1]!), ctx.range)],
  ["%(uint, uint)", (args, ctx) => uintModulo(unsigned(args[0]!), unsigned(args[1]!), ctx.range)],
  [
    "in(A, list<A>)",
    (args) => {
      // Membership reads every element, so an element that must be awaited is a door too, and
      // the refusal is TERMINAL as it is in a comprehension: answering `true` off the one
      // element that is readable decides the question against a list this engine cannot read.
      for (const held of list(args[1]!)) {
        const refused = asyncValueRefused(held);
        if (refused) return refused;
        if (celEqual(held, args[0]!)) return true;
      }
      return false;
    },
  ],
  ["in(K, map<K, V>)", (args) => typeof celLookup(args[1]!, args[0]!) !== "symbol"],

  // the optional library
  ["optional<A>.hasValue()", (args) => optional(args[0]!).present],
  [
    "optional<A>.value()",
    (args, ctx) => {
      const held = optional(args[0]!);
      return held.present
        ? (held.held as CelValue)
        : celError("optional_value_missing", "the optional holds no value", ctx.range);
    },
  ],
  ["optional<A>.or(optional<A>)", (args) => (optional(args[0]!).present ? args[0]! : args[1]!)],
  [
    "optional<A>.orValue(A)",
    (args) => (optional(args[0]!).present ? (optional(args[0]!).held as CelValue) : args[1]!),
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

function sizeOfMap(value: CelValue): number {
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
  ["==", (args) => celEqual(args[0]!, args[1]!)],
  ["!=", (args) => !celEqual(args[0]!, args[1]!)],
  ["<", ordering((compared) => compared < 0)],
  ["<=", ordering((compared) => compared <= 0)],
  [">", ordering((compared) => compared > 0)],
  [">=", ordering((compared) => compared >= 0)],
  ["type", (args, ctx) => celTypeValueOf(args[0]!, ctx.range)],
]);

function ordering(holds: (compared: number) => boolean): CelImplementation {
  return (args, ctx) => {
    const compared = celCompare(args[0]!, args[1]!);
    // Values that do not order at all — unrelated types, or a NaN. NaN orders with
    // nothing, including itself, so every comparison against it is false.
    if (compared === undefined) {
      if (isNotANumber(args[0]!) || isNotANumber(args[1]!)) return false;
      return celError(
        "no_matching_overload",
        `${celTypeNameOf(args[0]!) ?? "this value"} and ${celTypeNameOf(args[1]!) ?? "this value"} do not order`,
        ctx.range,
      );
    }
    return holds(compared);
  };
}

function isNotANumber(value: CelValue): boolean {
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
export function optionalOfNonZero(value: CelValue): CelOptional {
  return isZeroValue(value) ? celNone() : celSome(value);
}

/**
 * Whether a value is its type's zero. Every type that HAS one is listed; the types left out
 * are left out as a decision, not an omission — **an instant, a type value, an optional and
 * a host's named type have no zero in CEL**, because nothing in the language names one. An
 * engine that picked the epoch as a timestamp's zero would make
 * `optional.ofNonZeroValue(timestamp(0))` absent, which no row and no rule asks for.
 */
function isZeroValue(value: CelValue): boolean {
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
