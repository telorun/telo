/**
 * Plain encodings — the one canonical JSON form of each non-live `instance`
 * value type, keyed by the symbolic `encoding` an entry declares.
 *
 * An entry names its encoding the way it names its binding: a symbol, never code,
 * so every runtime reads the same vocabulary and maps each name to its own codec.
 * A value is decoded from this form only where it arrives from outside Telo — an
 * env var, a YAML literal — and holds the instance everywhere else.
 *
 * `decode` answers "is this text in the encoding, and what does it say" rather
 * than throwing: the caller that reads a literal leaves text it cannot decode in
 * place, and the value-type assertion then reports it, with {@link
 * PlainEncoding.form} naming what the author should have written. One refusal,
 * reached identically by `telo check` and at creation.
 */

import { EvaluationError, Environment } from "@marcbachmann/cel-js";
import { Duration } from "./cel-value-identity.js";

export interface PlainEncoding {
  /** How the text is written, for a message pointing an author at the form. */
  readonly form: string;
  /** The JSON Schema of the written text — what a reader outside Telo is told a
   *  slot holds (an OpenAPI document, a transport's own validator). */
  readonly schema: Readonly<Record<string, unknown>>;
  /** The value `text` encodes, or undefined when it is not in this encoding. */
  decode(text: string): unknown | undefined;
  /** The canonical text of a value of the type this encoding belongs to. */
  encode(value: unknown): string;
}

const BASE64URL = /^[A-Za-z0-9_-]*$/;

const base64url: PlainEncoding = {
  form: "base64url text without padding",
  schema: { type: "string", pattern: BASE64URL.source },
  decode(text) {
    // A length of 1 mod 4 names no whole byte; padding is not the canonical form.
    if (!BASE64URL.test(text) || text.length % 4 === 1) return undefined;
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  },
  encode(value) {
    if (!(value instanceof Uint8Array)) throw new TypeError("base64url encodes a Uint8Array");
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < value.length; i += chunk) {
      binary += String.fromCharCode(...value.subarray(i, i + chunk));
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
};

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/;

/** CEL's timestamp range: 0001-01-01T00:00:00Z to 9999-12-31T23:59:59.999Z. */
const MIN_INSTANT = -62135596800000;
const MAX_INSTANT = 253402300799999;

const rfc3339: PlainEncoding = {
  form: "RFC 3339 text (2026-01-15T09:30:00Z)",
  schema: { type: "string", format: "date-time" },
  decode(text) {
    const match = RFC3339.exec(text);
    if (!match) return undefined;
    const [, year, month, day, hour, minute, second, fraction, offset] = match;
    // `Date` rolls an out-of-range field over (Feb 30 is March 2), so the fields
    // are checked against themselves before the offset is applied. Set through
    // `setUTCFullYear`, since `Date.UTC` reads a year below 100 as 19xx.
    const fields = new Date(0);
    fields.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
    fields.setUTCHours(Number(hour), Number(minute), Number(second), 0);
    if (
      fields.getUTCFullYear() !== Number(year) ||
      fields.getUTCMonth() !== Number(month) - 1 ||
      fields.getUTCDate() !== Number(day) ||
      fields.getUTCHours() !== Number(hour) ||
      fields.getUTCMinutes() !== Number(minute) ||
      fields.getUTCSeconds() !== Number(second)
    ) {
      return undefined;
    }
    const millis = fraction ? Number(fraction.slice(0, 3).padEnd(3, "0")) : 0;
    const zone = offset!.toUpperCase() === "Z" ? 0 : offsetMinutes(offset!);
    if (zone === undefined) return undefined;
    const instant = fields.getTime() + millis - zone * 60_000;
    if (instant < MIN_INSTANT || instant > MAX_INSTANT) return undefined;
    return new Date(instant);
  },
  encode(value) {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new TypeError("rfc3339 encodes a valid Date");
    }
    return value.toISOString();
  },
};

/** An `±hh:mm` offset in minutes, or undefined when hours exceed 23 or minutes 59. */
function offsetMinutes(offset: string): number | undefined {
  const hours = Number(offset.slice(1, 3));
  const minutes = Number(offset.slice(4, 6));
  if (hours > 23 || minutes > 59) return undefined;
  return (offset[0] === "-" ? -1 : 1) * (hours * 60 + minutes);
}

/** CEL's own `duration()` conversion, compiled once, so every duration string CEL
 *  reads is read here — and nothing else is. */
let durationProgram: ((context: { text: string }) => unknown) | undefined;

export const NANOS_PER_SECOND = 1_000_000_000n;

/** protobuf Duration's range, which CEL adopts, in whole seconds either side of zero. */
export const MAX_DURATION_SECONDS = 315_576_000_000n;

const celDuration: PlainEncoding = {
  form: `a CEL duration string within ±${MAX_DURATION_SECONDS}s (1h30m, 250ms, 5400s)`,
  schema: { type: "string" },
  decode(text) {
    durationProgram ??= new Environment()
      .registerVariable("text", "string")
      .parse("duration(text)") as (context: { text: string }) => unknown;
    let value: unknown;
    try {
      value = durationProgram({ text });
    } catch (error) {
      if (error instanceof EvaluationError) return undefined;
      throw error;
    }
    const seconds = (value as Duration).seconds;
    return (seconds < 0n ? -seconds : seconds) > MAX_DURATION_SECONDS ? undefined : value;
  },
  encode(value) {
    if (!(value instanceof Duration)) throw new TypeError("cel-duration encodes a Duration");
    // Seconds with a trimmed fraction — the protobuf JSON form. Computed from the
    // parts rather than the class's own rendering, which misplaces the sign of a
    // negative duration with a fractional part.
    const total = value.seconds * NANOS_PER_SECOND + BigInt(value.nanos);
    const sign = total < 0n ? "-" : "";
    const magnitude = total < 0n ? -total : total;
    const nanos = magnitude % NANOS_PER_SECOND;
    const fraction = nanos === 0n ? "" : `.${nanos.toString().padStart(9, "0").replace(/0+$/, "")}`;
    return `${sign}${magnitude / NANOS_PER_SECOND}${fraction}s`;
  },
};

/** Every plain encoding this runtime implements, keyed by an entry's `encoding`. */
export const PLAIN_ENCODINGS: Readonly<Record<string, PlainEncoding>> = {
  base64url,
  rfc3339,
  "cel-duration": celDuration,
};

/** The plain encoding `name`, which `consumer` (a writer or reader built on it)
 *  cannot work without — a runtime missing it is refused where it loads. */
export function requirePlainEncoding(name: string, consumer: string): PlainEncoding {
  const encoding = PLAIN_ENCODINGS[name];
  if (!encoding) {
    throw new Error(`${consumer} needs the '${name}' plain encoding, which this runtime does not implement.`);
  }
  return encoding;
}
