/**
 * The CEL value domain, and how a value says what it is.
 *
 * **Identity is a string type key under `Symbol.for("telo.cel.value")`, never
 * `instanceof`.** Two copies of this engine loaded independently are two sets of
 * classes, so a constructor check would make a `uint` built by one copy not a uint to
 * the other — `+`, `type()` and every overload would refuse it. A symbol from the
 * global registry is the same symbol in both, so the key is readable across copies,
 * and because a symbol-keyed member cannot appear in parsed JSON an inbound request
 * body cannot forge a duration. A plain object carrying a *string*-keyed look-alike
 * (`{"telo.cel.value": "uint"}`) is therefore data: it reads as a map, as it must.
 *
 * What is **plain** carries no key, because the host platform already represents it
 * one way and only one: `null`, a boolean, a string, a double (`number`), an int
 * (`bigint`), bytes (`Uint8Array`), a list (an array) and a map whose keys are all
 * strings (a plain object, which is how a host hands one over). What has no faithful
 * plain form carries the key: a `uint` (a `bigint` is already an int), a timestamp and
 * a duration (both nanosecond-precise, which no host date type holds), a type value,
 * an optional, a map with typed keys, and a CEL error. A host's own named type
 * registers its own key, checked against this set at registration.
 *
 * The keys are a **closed set** (`CEL_VALUE_KEYS`); a new one is a change here.
 */

import type { CelLiteral, SourceRange } from "./syntax-tree.js";

export const CEL_VALUE_TYPE: unique symbol = Symbol.for("telo.cel.value");

/** The type keys this engine owns. A host-registered type may not reuse one. */
export const CEL_VALUE_KEYS = [
  "uint",
  "google.protobuf.Timestamp",
  "google.protobuf.Duration",
  "type",
  "optional",
  "map",
  "error",
] as const;

export type CelValueKey = (typeof CEL_VALUE_KEYS)[number];

interface Branded<Key extends string> {
  readonly [CEL_VALUE_TYPE]: Key;
}

/** An unsigned 64-bit integer. A `bigint` alone is already CEL's `int`. */
export interface CelUint extends Branded<"uint"> {
  readonly value: bigint;
}

/**
 * An instant: whole seconds since the epoch plus nanoseconds in `[0, 1e9)`, so a
 * negative instant is still `seconds` floored and `nanos` non-negative. Nanosecond
 * precision is required of the domain — `string(timestamp('…999999999Z'))` is a row.
 */
export interface CelTimestamp extends Branded<"google.protobuf.Timestamp"> {
  readonly seconds: bigint;
  readonly nanos: number;
}

/** A span: seconds and nanoseconds of the **same sign**, `|nanos| < 1e9`. */
export interface CelDuration extends Branded<"google.protobuf.Duration"> {
  readonly seconds: bigint;
  readonly nanos: number;
}

/** A type as a value — what `type(x)` answers and what `int` denotes. */
export interface CelTypeValue extends Branded<"type"> {
  readonly name: string;
}

/** `optional.of(v)` and `optional.none()`. */
export interface CelOptional extends Branded<"optional"> {
  readonly present: boolean;
  readonly held?: CelValue;
}

/** One entry of a map, keyed by the canonical text of its key (`cel-map-value.ts`). */
export interface CelMapValueEntry {
  readonly key: CelValue;
  readonly value: CelValue;
}

/**
 * A map. Entries live in a `Map` keyed by the canonical text of each key, so the map
 * holds int, uint, bool and string keys alike and **no key is ever a property name**:
 * `__proto__`, `constructor` and `prototype` are data here, as they are in any map.
 */
export interface CelMap extends Branded<"map"> {
  readonly entries: ReadonlyMap<string, CelMapValueEntry>;
}

/** Every evaluation failure this engine names. A code is never derived from a message. */
export const CEL_EVALUATION_CODES = [
  /** A map or a record does not hold the key read. */
  "no_such_key",
  /** A name nothing in the activation holds, at any prefix. */
  "no_such_variable",
  /** A list index below zero or past the last element. */
  "index_out_of_range",
  /** No registered overload takes the values a call was handed. */
  "no_matching_overload",
  /** A select, an index or an iteration over a value that holds no members. */
  "unsupported_container",
  /** A map key, or an index, of a type no map is keyed by. */
  "unsupported_key_type",
  /** A map literal or a comprehension building two entries with one key. */
  "duplicate_map_key",
  /** An int or uint result outside its own range. */
  "numeric_overflow",
  "division_by_zero",
  "modulo_by_zero",
  /** A conversion the value cannot make: `int('x')`, `timestamp` out of range. */
  "invalid_conversion",
  /** An argument a function refuses: an unknown time zone, a negative index. */
  "invalid_argument",
  /** A pattern RE2 cannot parse. */
  "invalid_regular_expression",
  /** `value()` on an optional that holds nothing. */
  "optional_value_missing",
  /** A namespaced call nothing bound an implementation for. */
  "unbound_function",
  /** A thenable reached evaluation. Evaluation is synchronous on both backends. */
  "async_value_unsupported",
] as const;

export type CelEvaluationCode = (typeof CEL_EVALUATION_CODES)[number];

/**
 * A failure as a **value**. It is not thrown: `false && <error>` is `false`, so every
 * operator, comprehension step and conditional carries an error-valued operand
 * through, and only the top of an evaluation turns a surviving one into a throw
 * (`cel-program.ts`). Throwing from the operator that found it would make the
 * short-circuit rules unimplementable.
 */
export interface CelError extends Branded<"error"> {
  readonly code: CelEvaluationCode;
  readonly message: string;
  readonly range?: SourceRange;
}

/** A value of a host-registered named type: its own key, outside `CEL_VALUE_KEYS`. */
export interface CelHostValue {
  readonly [CEL_VALUE_TYPE]: string;
}

/** A map whose keys are all strings, as a host hands one over. */
export interface CelRecord {
  readonly [key: string]: CelValue;
}

export type CelValue =
  | null
  | boolean
  | string
  | number
  | bigint
  | Uint8Array
  | readonly CelValue[]
  | CelUint
  | CelTimestamp
  | CelDuration
  | CelTypeValue
  | CelOptional
  | CelMap
  | CelError
  | CelHostValue
  | CelRecord;

// --- constructors ----------------------------------------------------------

export function celUint(value: bigint): CelUint {
  return { [CEL_VALUE_TYPE]: "uint", value };
}

export function celTypeValue(name: string): CelTypeValue {
  return { [CEL_VALUE_TYPE]: "type", name };
}

const NONE: CelOptional = { [CEL_VALUE_TYPE]: "optional", present: false };

export function celNone(): CelOptional {
  return NONE;
}

export function celSome(held: CelValue): CelOptional {
  return { [CEL_VALUE_TYPE]: "optional", present: true, held };
}

export function celError(
  code: CelEvaluationCode,
  message: string,
  range?: SourceRange,
): CelError {
  return { [CEL_VALUE_TYPE]: "error", code, message, ...(range ? { range } : {}) };
}

// --- reading what a value is ----------------------------------------------

/** The type key a value carries, or nothing when it carries none. */
function brandOf(value: object): string | undefined {
  const key = (value as { [CEL_VALUE_TYPE]?: unknown })[CEL_VALUE_TYPE];
  return typeof key === "string" ? key : undefined;
}

export function isCelError(value: unknown): value is CelError {
  return typeof value === "object" && value !== null && brandOf(value) === "error";
}

export function isCelOptional(value: unknown): value is CelOptional {
  return typeof value === "object" && value !== null && brandOf(value) === "optional";
}

export function isCelUint(value: unknown): value is CelUint {
  return typeof value === "object" && value !== null && brandOf(value) === "uint";
}

export function isCelMap(value: unknown): value is CelMap {
  return typeof value === "object" && value !== null && brandOf(value) === "map";
}

export function isCelTimestamp(value: unknown): value is CelTimestamp {
  return typeof value === "object" && value !== null && brandOf(value) === "google.protobuf.Timestamp";
}

export function isCelDuration(value: unknown): value is CelDuration {
  return typeof value === "object" && value !== null && brandOf(value) === "google.protobuf.Duration";
}

export function isCelTypeValue(value: unknown): value is CelTypeValue {
  return typeof value === "object" && value !== null && brandOf(value) === "type";
}

/**
 * Whether a value is bytes. `Object.prototype.toString` rather than `instanceof`, so a
 * buffer built in another realm is still bytes — the same reason the brand is a
 * registered symbol.
 */
export function isCelBytes(value: unknown): value is Uint8Array {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.prototype.toString.call(value) === "[object Uint8Array]"
  );
}

/**
 * Whether a value is a map a host handed over: a plain object, not a branded one.
 *
 * The prototype decides, which is why nothing else needs checking: an array, a buffer and
 * a class instance all have a prototype of their own, so none of them is a record. It is
 * also the cheapest test there is, and this runs on every member read.
 */
export function isCelRecord(value: unknown): value is CelRecord {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) return false;
  return brandOf(value) === undefined;
}

/**
 * The name of a value's CEL type, or nothing when the value is of no CEL type. It is
 * what `type()` answers and what an overload is dispatched on, so it must answer for
 * **any** value — `type()` has no `dyn` overload to fall back on.
 */
export function celTypeNameOf(value: unknown): string | undefined {
  switch (typeof value) {
    case "boolean":
      return "bool";
    case "string":
      return "string";
    case "number":
      return "double";
    case "bigint":
      return "int";
    case "object":
      break;
    default:
      return undefined;
  }
  if (value === null) return "null_type";
  const branded = brandOf(value as object);
  if (branded !== undefined) return branded === "error" ? undefined : branded;
  // Ordered by what an expression meets most: a host's map, then a list, then bytes,
  // whose test is the expensive one.
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype === Object.prototype || prototype === null) return "map";
  if (Array.isArray(value)) return "list";
  return isCelBytes(value) ? "bytes" : undefined;
}

/**
 * A thenable reaching evaluation is refused, never passed along: evaluation is
 * synchronous, and a promise flowing through an expression would be an invocation in
 * disguise — invisible to a journal, absent from a trace, and unrepresentable as a
 * step.
 *
 * The check is made at every **door** a host value comes through — an activation read, a
 * registered implementation's result, a member read, an element entering a comprehension
 * body, the value a name is bound to — and the list of them is in the package guide, which
 * is where completeness is argued. `asyncValueRefused` is the one error they all answer
 * with, so the code and the wording cannot drift between doors.
 */
export function isThenable(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * The refusal a value that must be awaited becomes, or nothing where it is an ordinary
 * value.
 *
 * **A container is NOT walked**, and that is deliberate rather than a gap: a thenable inside
 * a host list or map is refused when it becomes a value the engine reasons about — read by
 * index, read as a member, or bound into a body — so every element costs one `typeof` when it
 * is actually used, instead of every read costing a walk of what it returned.
 */
export function asyncValueRefused(value: unknown, range?: SourceRange): CelError | undefined {
  if (!isThenable(value)) return undefined;
  return celError(
    "async_value_unsupported",
    "a value that must be awaited reached evaluation, and CEL evaluates synchronously",
    range,
  );
}

/**
 * The value a literal node denotes. A tagged literal is not a bare host value — `1` and
 * `1u` are different expressions — so the one reading of a tag lives here, where both
 * backends and the checker's literal-argument guard reach it rather than each keeping a
 * switch of its own.
 */
export function literalValue(literal: CelLiteral): CelValue {
  switch (literal.type) {
    case "int":
      return literal.value;
    case "uint":
      return celUint(literal.value);
    case "double":
      return literal.value;
    case "string":
      return literal.value;
    case "bytes":
      return literal.value;
    case "bool":
      return literal.value;
    case "null":
      return null;
  }
}
