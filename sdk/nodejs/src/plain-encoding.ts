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

import { CEL_VALUE_TYPE, isCelError } from "@telorun/cel";
import { withLegacyDurationMethods } from "./legacy-value-classes.js";
import {
  durationNanosFromText,
  formatTimestamp,
  isCelDuration,
  isCelTimestamp,
  parseTimestamp,
  type CelDuration,
} from "./cel-value-identity.js";

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

/** The grammar this encoding reads: a four-digit year, `T` between date and time, a
 *  fraction of one to nine digits, and `Z` or an `±hh:mm` offset within ±23:59. A
 *  tenth fractional digit is a precision this domain does not hold, so it is REFUSED
 *  rather than rounded — the one reading of such text that cannot silently change what
 *  a writer meant. */
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

const rfc3339: PlainEncoding = {
  form: "RFC 3339 text (2026-01-15T09:30:00Z)",
  schema: { type: "string", format: "date-time" },
  decode(text) {
    // The grammar is this encoding's — no space separator, no tenth digit — and the
    // calendar, the offset and the range are the engine's `parseTimestamp`, so there
    // is exactly one reading of an instant's text in the runtime.
    if (!RFC3339.test(text)) return undefined;
    const value = parseTimestamp(text);
    return isCelError(value) ? undefined : value;
  },
  encode(value) {
    if (!isCelTimestamp(value)) throw new TypeError("rfc3339 encodes a timestamp");
    // RFC 3339 in UTC with a trimmed fraction, which is CEL's own `string(timestamp)`
    // — the engine is the authority for the text, so a frame payload, a transport body
    // and a `!interpolate` hole all write one instant the same way.
    return formatTimestamp(value);
  },
};

export const NANOS_PER_SECOND = 1_000_000_000n;

/** protobuf Duration's range, in whole seconds either side of zero. **CEL's own duration is
 *  a SUBRANGE of it** — a single int64 of nanoseconds — so the engine's reading is the
 *  binding bound and this one is the outer one the typed frame carries. */
export const MAX_DURATION_SECONDS = 315_576_000_000n;

const celDuration: PlainEncoding = {
  form: `a CEL duration string within ±${MAX_DURATION_SECONDS}s (1h30m, 250ms, 5400s)`,
  schema: { type: "string" },
  decode(text) {
    // **CEL's grammar, protobuf's range.** The two are separate questions and this encoding
    // answers the wider one: a journal entry, a transport's payload and a controller's value
    // all reach protobuf's ±10,000 years, which cannot be held in an int64 of nanoseconds at
    // all — so the engine's `parseDuration`, which applies CEL's range, cannot read one.
    // `durationNanosFromText` is the grammar without a range, so there is one reading of the
    // text and the bound is applied here. A value past CEL's own range is refused where it
    // enters the engine, not here.
    const total = durationNanosFromText(text);
    if (isCelError(total)) return undefined;
    const seconds = total / NANOS_PER_SECOND;
    if ((seconds < 0n ? -seconds : seconds) > MAX_DURATION_SECONDS) return undefined;
    // The legacy `getMilliseconds()` rides along, non-enumerably: a controller published
    // against the replaced `Duration` class reads a slot's decoded value through it, and
    // the artifact cannot be edited. See `legacy-value-classes.ts`.
    return withLegacyDurationMethods({
      [CEL_VALUE_TYPE]: "google.protobuf.Duration",
      seconds,
      nanos: Number(total % NANOS_PER_SECOND),
    } as CelDuration);
  },
  encode(value) {
    if (!isCelDuration(value)) throw new TypeError("cel-duration encodes a duration");
    // Seconds with a trimmed fraction — the protobuf JSON form, which this package owns and
    // computes from the parts rather than asking the engine to render it.
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
