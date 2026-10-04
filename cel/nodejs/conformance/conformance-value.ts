/**
 * The conformance value: the vectors' one encoding for every value, read into this
 * engine's domain and written back out of it.
 *
 * It is the typed frame (`kernel/specs/durable-execution.md` §6) held as a JSON value,
 * plus two `$cel` forms for a type value and an optional. Writing is **canonical** — one
 * text per value — so comparing a row's recorded answer against the engine's is a
 * comparison of two texts, and a difference of CEL *type* is a difference of text: an
 * int, a uint and a double never encode alike, NaN and `-0` are written as tags, and a
 * map's keys are ordered rather than left in insertion order.
 *
 * It is written here, in the driver, rather than taken from a Telo package: this engine
 * depends on nothing in the repository, in either direction, and a conformance row is
 * data the driver reads.
 *
 * One translation the format forces: **the recording spells the null type `null`**, where
 * this engine names the type value `null_type`. Both directions map it, so a comparison
 * is still a comparison of the same value.
 */

import {
  celMapFromEntries,
  celNone,
  celSome,
  celTypeValue,
  celUint,
  formatDuration,
  formatTimestamp,
  isCelBytes,
  isCelDuration,
  isCelError,
  isCelMap,
  isCelOptional,
  isCelRecord,
  isCelTimestamp,
  isCelTypeValue,
  isCelUint,
  parseDuration,
  parseTimestamp,
  timestampNanos,
  type CelValue,
} from "../src/index.js";

export type ConformanceValue =
  | null
  | boolean
  | number
  | string
  | ConformanceValue[]
  | { [key: string]: ConformanceValue };

const FRAME_TAG = "$telo";
const CEL_TAG = "$cel";

/** A value the encoding cannot carry. Refusing is never a stand-in. */
export class ConformanceValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConformanceValueError";
  }
}

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function base64url(bytes: Uint8Array): string {
  let out = "";
  for (let at = 0; at < bytes.length; at += 3) {
    const a = bytes[at]!;
    const b = bytes[at + 1];
    const c = bytes[at + 2];
    out += BASE64URL[a >> 2]! + BASE64URL[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    if (b === undefined) break;
    out += BASE64URL[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    if (c === undefined) break;
    out += BASE64URL[c & 63]!;
  }
  return out;
}

function unbase64url(text: string): Uint8Array {
  const bits: number[] = [];
  for (const ch of text) {
    const at = BASE64URL.indexOf(ch);
    if (at < 0) throw new ConformanceValueError(`${JSON.stringify(text)} is not base64url`);
    bits.push(at);
  }
  const out: number[] = [];
  for (let at = 0; at < bits.length; at += 4) {
    const [a, b, c, d] = [bits[at], bits[at + 1], bits[at + 2], bits[at + 3]];
    if (b !== undefined) out.push(((a! << 2) | (b >> 4)) & 0xff);
    if (c !== undefined) out.push(((b! << 4) | (c >> 2)) & 0xff);
    if (d !== undefined) out.push(((c! << 6) | d) & 0xff);
  }
  return Uint8Array.from(out);
}

/** How a type value is spelled in the vectors, which is not always how it is here. */
function recordedTypeName(name: string): string {
  return name === "null_type" ? "null" : name;
}

function engineTypeName(recorded: string): string {
  return recorded === "null" ? "null_type" : recorded;
}

function tagged(tag: string, value: string): ConformanceValue {
  return { [FRAME_TAG]: tag, value };
}

/** A value as the vectors write it, canonically. Throws on a value outside the domain. */
export function encodeConformanceValue(value: CelValue): ConformanceValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return tagged("double", "NaN");
    if (value === Number.POSITIVE_INFINITY) return tagged("double", "Infinity");
    if (value === Number.NEGATIVE_INFINITY) return tagged("double", "-Infinity");
    if (Object.is(value, -0)) return tagged("double", "-0");
    return value;
  }
  if (typeof value === "bigint") return tagged("int", String(value));
  if (isCelUint(value)) return tagged("uint", String(value.value));
  if (isCelBytes(value)) return tagged("bytes", base64url(value));
  if (isCelTimestamp(value)) {
    if (value.nanos % 1_000_000 !== 0) {
      throw new ConformanceValueError(
        `the instant ${formatTimestamp(value)} is finer than a millisecond, which the encoding does not carry`,
      );
    }
    const whole = timestampNanos(value) % 1_000_000_000n === 0n;
    const text = formatTimestamp(value);
    return tagged("google.protobuf.Timestamp", whole ? `${text.slice(0, -1)}.000Z` : padMilliseconds(text));
  }
  if (isCelDuration(value)) return tagged("google.protobuf.Duration", formatDuration(value));
  if (isCelTypeValue(value)) return { [CEL_TAG]: "type", value: recordedTypeName(value.name) };
  if (isCelOptional(value)) {
    return value.present
      ? { [CEL_TAG]: "optional", value: encodeConformanceValue(value.held as CelValue) }
      : { [CEL_TAG]: "optional" };
  }
  if (Array.isArray(value)) return value.map((held) => encodeConformanceValue(held));
  if (isCelMap(value)) {
    return encodeMap([...value.entries.values()].map((entry) => [entry.key, entry.value]));
  }
  if (isCelRecord(value)) {
    return encodeMap(Object.keys(value).map((key) => [key, value[key] as CelValue]));
  }
  if (isCelError(value)) throw new ConformanceValueError(`an error is not a value: ${value.message}`);
  throw new ConformanceValueError("this value is of no CEL type");
}

/** The millisecond form the encoding carries: exactly three fractional digits. */
function padMilliseconds(text: string): string {
  const [body, fraction] = text.slice(0, -1).split(".");
  return `${body}.${(fraction ?? "").padEnd(3, "0").slice(0, 3)}Z`;
}

function encodeMap(pairs: readonly (readonly [CelValue, CelValue])[]): ConformanceValue {
  const written = pairs.map(([key, value]) => ({
    key: encodeConformanceValue(key),
    value: encodeConformanceValue(value),
  }));
  const plain = written.every(
    (pair) => typeof pair.key === "string" && pair.key !== FRAME_TAG && pair.key !== CEL_TAG,
  );
  if (plain) {
    const sorted = [...written].sort((left, right) =>
      compareText(left.key as string, right.key as string),
    );
    return Object.fromEntries(sorted.map((pair) => [pair.key as string, pair.value]));
  }
  const sorted = [...written].sort((left, right) =>
    compareText(JSON.stringify(left.key), JSON.stringify(right.key)),
  );
  return { [FRAME_TAG]: "map", value: sorted.map((pair) => [pair.key, pair.value]) };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** A recorded value as a value of this engine. Throws on a node the encoding does not define. */
export function decodeConformanceValue(node: ConformanceValue): CelValue {
  if (node === null || typeof node === "boolean" || typeof node === "string") return node;
  if (typeof node === "number") return node;
  if (Array.isArray(node)) return node.map((held) => decodeConformanceValue(held));
  if (Object.prototype.hasOwnProperty.call(node, CEL_TAG)) return decodeCel(node);
  if (Object.prototype.hasOwnProperty.call(node, FRAME_TAG)) return decodeFrame(node);
  const flat: CelValue[] = [];
  for (const key of Object.keys(node)) flat.push(key, decodeConformanceValue(node[key]!));
  return expectValue(celMapFromEntries(flat));
}

function decodeCel(node: { [key: string]: ConformanceValue }): CelValue {
  const form = node[CEL_TAG];
  if (form === "type" && typeof node.value === "string") {
    return celTypeValue(engineTypeName(node.value));
  }
  if (form === "optional") {
    return node.value === undefined ? celNone() : celSome(decodeConformanceValue(node.value));
  }
  throw new ConformanceValueError(`${JSON.stringify(node)} is not a '${CEL_TAG}' form`);
}

function decodeFrame(node: { [key: string]: ConformanceValue }): CelValue {
  const tag = node[FRAME_TAG];
  const payload = node.value;
  if (tag === "map") {
    if (!Array.isArray(payload)) throw new ConformanceValueError("a tagged map carries its pairs");
    const flat: CelValue[] = [];
    for (const pair of payload) {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new ConformanceValueError("a tagged map's entry is a [key, value] pair");
      }
      flat.push(decodeConformanceValue(pair[0]!), decodeConformanceValue(pair[1]!));
    }
    return expectValue(celMapFromEntries(flat));
  }
  if (typeof payload !== "string") {
    throw new ConformanceValueError(`the tag ${JSON.stringify(tag)} carries its payload as text`);
  }
  switch (tag) {
    case "int":
      return BigInt(payload);
    case "uint":
      return celUint(BigInt(payload));
    case "double":
      if (payload === "NaN") return Number.NaN;
      if (payload === "Infinity") return Number.POSITIVE_INFINITY;
      if (payload === "-Infinity") return Number.NEGATIVE_INFINITY;
      if (payload === "-0") return -0;
      throw new ConformanceValueError(`${JSON.stringify(payload)} is not a tagged double`);
    case "bytes":
      return unbase64url(payload);
    case "google.protobuf.Timestamp":
      return expectValue(parseTimestamp(payload));
    case "google.protobuf.Duration":
      return expectValue(parseDuration(payload));
    default:
      throw new ConformanceValueError(`${JSON.stringify(tag)} is not a tag of the encoding`);
  }
}

function expectValue(value: CelValue): CelValue {
  if (isCelError(value)) throw new ConformanceValueError(value.message);
  return value;
}

/**
 * The canonical text of a recorded node or an engine value — what the two sides of a
 * comparison are reduced to. A recorded node goes through the engine's domain first, so a
 * row written in a form that is not canonical is caught rather than compared loosely.
 */
export function conformanceText(value: CelValue): string {
  return JSON.stringify(encodeConformanceValue(value));
}

/** Kept for a message: a value the engine answered, however it is written. */
export function describeValue(value: CelValue): string {
  try {
    return conformanceText(value);
  } catch (cause) {
    return `<${(cause as Error).message}>`;
  }
}
