/**
 * What every function of the catalog **does** — once, for both backends.
 *
 * The declarations are data (`signatures/function-catalog.json`); this is the behaviour
 * behind them, keyed by the same dispatch key the registry resolves on, exactly as
 * `runtime-library.ts` is for CEL's own library. Both backends reach it through the
 * registration's `implementation`, so there is one answer per operation and no second
 * copy to drift.
 *
 * **Nine functions are the HOST's**, not this engine's: the four hashes, `hmac`, the two
 * base64 string conversions, `json` and `joinPath`. Each needs a platform facility this
 * package may not reach — a hash, a byte buffer, the host's own path separator — so the
 * host supplies it through `CelCatalogHandlers` and a registration made without one
 * answers an `unbound_function` error **naming the function**. Never a null, and never a
 * silent empty string: a hash that answers nothing looks like a value and ends up in a
 * cache key.
 *
 * **A refusal is worded by the catalog, in one voice** — `<function>: <what is wrong>` —
 * and never by a library or by the host language's runtime. It is thrown as
 * `CatalogRefusal` by the guard that meets it and turned into a CEL **error value** at
 * exactly one place (`refusing`), so the short-circuit rules still hold and the static
 * guard below reports the same sentence the evaluation would. Anything else thrown while
 * an implementation runs is this engine failing, not the argument, and propagates.
 */

import { BoundedCache } from "./bounded-cache.js";
import { celMapOf, mapKeyIdentity } from "./cel-map-value.js";
import type {
  CelCallContext,
  CelImplementation,
} from "./runtime-library.js";
import { base64Text, jsonAsCelValue } from "./runtime-library.js";
import type { LiteralArgumentCheck } from "./signature.js";
import type {
  CelEvaluationCode,
  CelMap,
  CelMapValueEntry,
  CelRecord,
  CelTimestamp,
  CelValue,
} from "./cel-value.js";
import {
  celError,
  celTypeNameOf,
  isCelBytes,
  isCelDuration,
  isCelMap,
  isCelRecord,
  isCelTimestamp,
  isCelUint,
} from "./cel-value.js";
import { formatDuration } from "./duration-value.js";
import { scanJsonPrefix } from "./json-text-scan.js";
import { re2Pattern, RE2_FLAG_LETTERS } from "./regular-expression.js";
import type { RE2JS } from "re2js";
import { celTimestamp, formatTimestamp } from "./timestamp-value.js";
import { celEqual } from "./value-equality.js";
import { bytesToText, doubleText } from "./value-text.js";
import {
  civilTimeIn,
  dateTextIn,
  daysInMonth,
  instantOfCivilTime,
  isoTextIn,
  knownTimeZone,
} from "./zoned-calendar.js";
import { formatLocale } from "d3-format";
import { v1, v3, v4, v5, v6, v7, validate as uuidValidate, version as uuidVersion } from "uuid";

/**
 * The nine functions the host answers for. Each needs a facility this package may not
 * reach, which is the whole of why it is a seam: a hash and a byte buffer are the host
 * platform's, and what a path separator IS belongs to the machine running the app.
 */
export interface CelCatalogHandlers {
  sha256: (text: string) => string;
  md5: (text: string) => string;
  sha1: (text: string) => string;
  sha512: (text: string) => string;
  hmac: (algorithm: string, key: string, message: string) => string;
  base64Encode: (text: string) => string;
  base64Decode: (text: string) => string;
  json: (value: CelValue) => string;
  /** Join a relative path onto a base with the HOST's path rules. */
  joinPath: (base: string, relative: string) => string;
}

/** An implementation, once the host's handlers are known. */
export type CatalogImplementation = (handlers: Partial<CelCatalogHandlers>) => CelImplementation;

/**
 * A refusal a catalog function makes of its arguments. It carries the evaluation code the
 * refusal answers with, so a pattern RE2 cannot parse is not reported as the same kind of
 * mistake as a decimal count out of range.
 */
class CatalogRefusal extends Error {
  readonly code: CelEvaluationCode;

  constructor(message: string, code: CelEvaluationCode = "invalid_argument") {
    super(message);
    this.name = "CatalogRefusal";
    this.code = code;
  }
}

/** The one place a refusal becomes a value. Anything else thrown is a defect here. */
function refusing(run: (args: readonly CelValue[], ctx: CelCallContext) => CelValue): CelImplementation {
  return (args, ctx) => {
    try {
      return run(args, ctx);
    } catch (cause) {
      if (cause instanceof CatalogRefusal) return celError(cause.code, cause.message, ctx.range);
      throw cause;
    }
  };
}

/** An implementation that needs nothing of the host. */
const own =
  (run: (args: readonly CelValue[], ctx: CelCallContext) => CelValue): CatalogImplementation =>
  () =>
    refusing(run);

/**
 * An implementation the host supplies. With no handler the call answers an
 * `unbound_function` error naming the function — the registration is still made, so the
 * expression still type-checks, which is what an analyzer that never evaluates needs.
 */
const hosted =
  <K extends keyof CelCatalogHandlers>(
    name: K,
    build: (
      handler: CelCatalogHandlers[K],
    ) => (args: readonly CelValue[], ctx: CelCallContext) => CelValue,
  ): CatalogImplementation =>
  (handlers) => {
    const handler = handlers[name];
    if (handler === undefined) {
      return (_args, ctx) =>
        celError(
          "unbound_function",
          `${name}() is supplied by the host, and this environment was given no implementation for it`,
          ctx.range,
        );
    }
    return refusing(build(handler));
  };

// --- reading arguments ------------------------------------------------------

const text = (value: CelValue): string => value as string;
const bytes = (value: CelValue): Uint8Array => value as Uint8Array;

/**
 * A list argument. Every list-taking entry reads one through here, because a `dyn` slot can
 * carry anything: the engine being replaced answered `0` for `sum` of a non-list and failed
 * with its host language's own `TypeError` for the rest, and neither is an answer about the
 * argument. Named in the catalog's voice instead, as an instant and a map already are.
 */
function list(what: string, value: CelValue): readonly CelValue[] {
  if (Array.isArray(value)) return value;
  throw new CatalogRefusal(`${what}: expected a list, got ${celTypeNameOf(value) ?? "no CEL value"}`);
}

/** A value as a number, the way every arithmetic and formatting entry reads one. */
function numberOf(value: CelValue): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (isCelUint(value)) return Number(value.value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === null) return 0;
  if (typeof value === "string") return value.trim() === "" ? 0 : Number(value);
  return Number.NaN;
}

/**
 * A value as text, for `join` and for ordering a list of non-numbers. Every type whose
 * single written form the engine defines is written that way — the same text `string()`
 * answers. A container has no such form, and is **named rather than coerced**: the
 * engine being replaced wrote a map as `[object Object]`, which is a value no author
 * ever wrote and which prints into a document.
 */
function textOf(what: string, value: CelValue): string {
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return String(value);
  if (isCelUint(value)) return String(value.value);
  if (typeof value === "number") return doubleText(value);
  if (typeof value === "boolean") return String(value);
  if (value === null) return "null";
  if (isCelTimestamp(value)) return formatTimestamp(value);
  if (isCelDuration(value)) return formatDuration(value);
  if (isCelBytes(value)) {
    const decoded = bytesToText(value);
    if (typeof decoded === "string") return decoded;
    throw new CatalogRefusal(`${what}: the bytes are not UTF-8 text`, "invalid_conversion");
  }
  if (Array.isArray(value)) return value.map((held) => textOf(what, held)).join(",");
  throw new CatalogRefusal(
    `${what}: a value of type ${celTypeNameOf(value) ?? "none"} has no text`,
    "invalid_conversion",
  );
}

/** An instant argument. A `dyn` slot can carry anything, so it is named, never coerced. */
function instantArg(what: string, value: CelValue): CelTimestamp {
  if (isCelTimestamp(value)) return value;
  throw new CatalogRefusal(`${what}: expected a timestamp`);
}

/** An instant as host milliseconds, which is the granularity the calendar works at. */
function millisOf(value: CelTimestamp): number {
  return Number(value.seconds) * 1000 + Math.floor(value.nanos / 1_000_000);
}

/** An instant from host milliseconds; out of CEL's range it is the domain's own error. */
function instantOfMillis(what: string, millis: number): CelValue {
  const whole = Math.floor(millis / 1000);
  const rest = millis - whole * 1000;
  const built = celTimestamp(BigInt(whole), BigInt(rest) * 1_000_000n);
  if (isCelTimestamp(built)) return built;
  throw new CatalogRefusal(`${what}: the result is outside the range of a timestamp`, "invalid_conversion");
}

/** A map's entries, whichever container holds them. A list is named rather than joined. */
function mapEntries(what: string, value: CelValue): readonly (readonly [CelValue, CelValue])[] {
  if (isCelMap(value)) return [...value.entries.values()].map((entry) => [entry.key, entry.value] as const);
  if (Array.isArray(value)) {
    throw new CatalogRefusal(`${what}: expected a map, got a list — use '+' to join lists`);
  }
  if (isCelRecord(value)) {
    return Object.keys(value).map((key) => [key, value[key] as CelValue] as const);
  }
  throw new CatalogRefusal(`${what}: expected a map, got ${celTypeNameOf(value) ?? "no CEL value"}`);
}

/** A map of the same container the entries came out of, so what comes back is what went in. */
function mapOfEntries(like: CelValue, pairs: readonly (readonly [CelValue, CelValue])[]): CelValue {
  if (isCelMap(like)) {
    const entries = new Map<string, CelMapValueEntry>();
    for (const [key, value] of pairs) {
      const identity = mapKeyIdentity(key);
      if (identity === undefined) continue;
      entries.set(identity, { key, value });
    }
    return celMapOf(entries) as CelMap;
  }
  const out = Object.create(null) as Record<string, CelValue>;
  for (const [key, value] of pairs) out[key as string] = value;
  return out as CelRecord;
}

// --- formatting -------------------------------------------------------------

/**
 * The number-formatting locale, pinned rather than defaulted.
 *
 * d3-format's default locale renders a negative with U+2212 MINUS SIGN, so
 * `format(-1.5, '.2f')` would be `"-1.50"` with a character no downstream parser,
 * comparison or diff treats as the number it looks like. Every field is fixed to its
 * ASCII form for the same reason the layer is locale-free at all: the same manifest must
 * render the same bytes on every runtime, and a second engine implementing the specifier
 * grammar has to be able to reproduce these exactly.
 */
const FORMAT_LOCALE = formatLocale({
  decimal: ".",
  thousands: ",",
  grouping: [3],
  currency: ["$", ""],
  minus: "-",
  percent: "%",
  nan: "NaN",
});

/** Largest integer a double represents exactly. */
const MAX_EXACT_INT = 9007199254740991n;

/**
 * A number d3 can format. A CEL int is a `bigint` and d3 throws on one outright, so it is
 * converted here — and past 2^53 a double stops representing every integer, so emitting a
 * number that is not the one the author computed is refused rather than printed.
 */
function formattable(what: string, value: CelValue): number {
  if (typeof value === "bigint" || isCelUint(value)) {
    const whole = typeof value === "bigint" ? value : value.value;
    if (whole > MAX_EXACT_INT || whole < -MAX_EXACT_INT) {
      throw new CatalogRefusal(
        `${what}: integer ${whole} exceeds 2^53-1 and cannot be formatted exactly as a double`,
      );
    }
    return Number(whole);
  }
  const number = numberOf(value);
  // The runtime backstop behind the typed registrations. A value that is not a number
  // formats as the string "NaN", which is the failure this family exists to remove: it
  // looks like an answer and prints into a document.
  if (!Number.isFinite(number)) {
    throw new CatalogRefusal(
      `${what}: expected a finite number, got ${celTypeNameOf(value) ?? "no CEL value"}`,
    );
  }
  return number;
}

/**
 * Specifier type characters d3 implements. An unknown one PARSES — `.2q` yields `"1"`
 * rather than throwing — so a typo would silently format against the default type.
 */
const FORMAT_TYPES = new Set([..."efgrs%pbodxXcn"]);

/**
 * Decimal places, bounded. The ceiling is well below what `toFixed` accepts because past
 * it the digits are an artefact of the binary representation rather than of the value.
 *
 * ONE rule, enforced wherever a precision is written: `formatter` applies it to a
 * specifier's `.precision` group too. Bounding only `fixed` let an author route around
 * the guard by writing `format(x, '.11f')` — the family giving two answers to one
 * question. Every specifier type and flag stays available; only the digit count is capped.
 */
const MAX_DECIMALS = 10;

function digitCount(what: string, digits: CelValue): number {
  const count = numberOf(digits);
  if (!Number.isInteger(count) || count < 0 || count > MAX_DECIMALS) {
    throw new CatalogRefusal(
      `${what}: decimal places must be an integer 0-${MAX_DECIMALS}, got ${textOf(what, digits)}`,
    );
  }
  return count;
}

/**
 * A specifier is a CEL value, so it can be request-derived — a server evaluating
 * `format(x, request.query.spec)` would otherwise grow this map for the life of the
 * process. Bounded, with its capacity declared, like every cache in this package.
 */
const FORMATTER_CACHE_CAPACITY = 256;
const formatters = new BoundedCache<string, (value: number) => string>(FORMATTER_CACHE_CAPACITY);

function formatter(what: string, specifier: CelValue): (value: number) => string {
  const written = textOf(what, specifier);
  const held = formatters.get(written);
  if (held) return held;
  const type = written.slice(-1);
  if (written !== "" && /[a-zA-Z%]/.test(type) && !FORMAT_TYPES.has(type)) {
    throw new CatalogRefusal(
      `${what}: unknown format type '${type}' (one of ${[...FORMAT_TYPES].join("")})`,
    );
  }
  // The `.precision` group — width is the digits BEFORE the dot, so this is the only
  // `.`-digits sequence the grammar admits.
  const precision = /\.(\d+)/.exec(written);
  if (precision) digitCount(what, precision[1]!);
  let built: (value: number) => string;
  try {
    built = FORMAT_LOCALE.format(written);
  } catch {
    throw new CatalogRefusal(`${what}: invalid format specifier ${JSON.stringify(written)}`);
  }
  formatters.set(written, built);
  return built;
}

/** Render a minute count against a declared day length — a policy, never an assumption. */
function durationText(minutes: CelValue, minutesPerDay: CelValue): string {
  const perDay = Math.round(formattable("formatDuration", minutesPerDay));
  if (!Number.isFinite(perDay) || perDay <= 0) {
    throw new CatalogRefusal(`formatDuration: minutesPerDay must be a positive number, got ${perDay}`);
  }
  const total = Math.round(formattable("formatDuration", minutes));
  const magnitude = Math.abs(total);
  const days = Math.floor(magnitude / perDay);
  const withinDay = magnitude % perDay;
  const hours = Math.floor(withinDay / 60);
  const minutesLeft = withinDay % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutesLeft) parts.push(`${minutesLeft}m`);
  if (parts.length === 0) parts.push("0m");
  return `${total < 0 ? "-" : ""}${parts.join(" ")}`;
}

// --- time zones -------------------------------------------------------------

/** Refuse an unknown zone in the catalog's own voice, never as a host `RangeError`. */
function zoneArg(what: string, value: CelValue | undefined): string {
  const zone = value === undefined ? "UTC" : textOf(what, value);
  if (!knownTimeZone(zone)) {
    throw new CatalogRefusal(`${what}: unknown IANA time zone ${JSON.stringify(zone)}`);
  }
  return zone;
}

// --- regular expressions ----------------------------------------------------

/** The flag letters the catalog's regex family reads. `g` is accepted and means nothing. */
function re2Flags(what: string, flags: CelValue | undefined): number {
  let bits = 0;
  for (const letter of flags === undefined ? "" : textOf(what, flags)) {
    if (letter === "g") continue;
    const bit = RE2_FLAG_LETTERS[letter];
    if (bit === undefined) {
      throw new CatalogRefusal(
        `${what}: unknown regex flag '${letter}' (supported: ${Object.keys(RE2_FLAG_LETTERS).join(", ")})`,
      );
    }
    bits |= bit;
  }
  return bits;
}

/**
 * A compiled pattern, or the catalog's refusal naming RE2's own parse-error kind and
 * nothing after it — the library's prefix and the fragment it quotes never reach an
 * author. A parse failure outside that closed vocabulary is a defect here, raised as one
 * with the library's message rather than printed as though it were a kind.
 */
function pattern(what: string, source: CelValue, flags: CelValue | undefined): RE2JS {
  const bits = re2Flags(what, flags);
  const written = textOf(what, source);
  return patternOrRefusal(what, written, bits);
}

function patternOrRefusal(what: string, written: string, bits: number): RE2JS {
  const compiled = re2Pattern(written, bits);
  if (!("refused" in compiled)) return compiled.pattern;
  const { kind, message } = compiled.refused;
  if (kind === undefined) {
    throw new Error(
      `${what}: the RE2 compiler failed on pattern ${JSON.stringify(written)} with an error outside the closed parse-error vocabulary: ${message}`,
    );
  }
  throw new CatalogRefusal(
    `${what}: invalid RE2 pattern ${JSON.stringify(written)}: ${kind}`,
    "invalid_regular_expression",
  );
}

// --- base64 ----------------------------------------------------------------

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Base64 to bytes, written out rather than delegated: the host's `atob` round-trips
 * through a string, which is the corruption this pair exists to avoid. The URL-safe
 * alphabet and missing padding are both accepted, since both appear in real API payloads;
 * a character outside the alphabet is refused rather than silently dropped.
 */
function bytesFromBase64(input: string): Uint8Array {
  const clean = input
    .replace(/[\r\n\t ]/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/=+$/, "");
  // A remainder of 1 cannot come from any byte sequence: base64 writes 3 bytes as 4
  // characters, so the valid remainders are 0, 2 and 3. Left to the loop it would leave
  // six bits unwritten and answer a SHORT buffer — the silently dropped byte this
  // function refuses a bad character for.
  if (clean.length % 4 === 1) {
    throw new CatalogRefusal("bytesFromBase64: input length is not valid base64");
  }
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let accumulated = 0;
  let written = 0;
  for (const character of clean) {
    const value = BASE64_ALPHABET.indexOf(character);
    if (value < 0) {
      throw new CatalogRefusal(`bytesFromBase64: '${character}' is not a base64 character`);
    }
    accumulated = (accumulated << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written++] = (accumulated >> bits) & 0xff;
    }
  }
  return out.subarray(0, written);
}

// --- JSON ------------------------------------------------------------------

/**
 * The host parser's verdict stands; the scan beside it only words the refusal. A text the
 * host refused and the scan reads as valid JSON is a defect here, raised as one with the
 * host's error as its cause.
 */
function parseJsonText(written: string): CelValue {
  try {
    return jsonAsCelValue(JSON.parse(written));
  } catch (hostRefusal) {
    const refusal = scanJsonPrefix(written);
    if (refusal === undefined) {
      throw new Error("parseJson: the host JSON parser refused a text the catalog's scan reads as valid JSON", {
        cause: hostRefusal,
      });
    }
    throw new CatalogRefusal(
      `parseJson: invalid JSON at offset ${refusal.offset}${refusal.endOfInput ? " (unexpected end of input)" : ""}`,
      "invalid_conversion",
    );
  }
}

// --- collections ------------------------------------------------------------

function smallest(values: readonly CelValue[], wantSmallest: boolean): CelValue {
  if (values.length === 0) return null;
  let best: CelValue = values[0]!;
  let bestNumber = numberOf(best);
  for (const held of values) {
    const number = numberOf(held);
    if (wantSmallest ? number < bestNumber : number > bestNumber) {
      best = held;
      bestNumber = number;
    }
  }
  return best;
}

/**
 * A sorted copy: numerically where the first element is a number, else by text. One rule
 * read off the first element, as the engine being replaced read it — a list CEL would
 * refuse to order is not what this function is for.
 */
function sorted(what: string, values: readonly CelValue[]): CelValue[] {
  const first = values[0];
  const numeric =
    typeof first === "number" || typeof first === "bigint" || isCelUint(first as CelValue);
  return [...values].sort((left, right) => {
    if (numeric) {
      const difference = numberOf(left) - numberOf(right);
      return difference < 0 ? -1 : difference > 0 ? 1 : 0;
    }
    const a = textOf(what, left);
    const b = textOf(what, right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * Duplicates removed by **CEL equality**, which is the only identity this value domain
 * has: a uint, an instant and a map are objects here, so a host-level identity would call
 * two equal values different and answer a list the expression never asked for.
 */
function distinct(values: readonly CelValue[]): CelValue[] {
  const out: CelValue[] = [];
  for (const held of values) {
    if (!out.some((kept) => celEqual(kept, held))) out.push(held);
  }
  return out;
}

/** Drop entries whose value is null or the empty string. Nothing else. */
function compacted(value: CelValue): CelValue {
  const keep = (held: CelValue): boolean => held !== null && held !== "";
  if (Array.isArray(value)) return value.filter(keep);
  return mapOfEntries(
    value,
    mapEntries("compact", value).filter(([, held]) => keep(held)),
  );
}

// --- the table -------------------------------------------------------------

const IMPLEMENTATIONS = new Map<string, CatalogImplementation>([
  // collections
  ["join(list<dyn>, string)", own((args) => list("join", args[0]!).map((held) => textOf("join", held)).join(text(args[1]!)))],
  ["keys(map<dyn, dyn>)", own((args) => mapEntries("keys", args[0]!).map(([key]) => key))],
  ["values(map<dyn, dyn>)", own((args) => mapEntries("values", args[0]!).map(([, value]) => value))],
  ["distinct(list<dyn>)", own((args) => distinct(list("distinct", args[0]!)))],
  ["reverse(list<dyn>)", own((args) => [...list("reverse", args[0]!)].reverse())],
  ["flatten(list<dyn>)", own((args) => (list("flatten", args[0]!) as CelValue[]).flat())],
  ["sort(list<dyn>)", own((args) => sorted("sort", list("sort", args[0]!)))],
  [
    "range(int)",
    own((args) =>
      Array.from({ length: Math.max(0, Math.trunc(numberOf(args[0]!))) }, (_unused, at) => BigInt(at)),
    ),
  ],
  [
    "enumerate(list<dyn>)",
    own((args) =>
      list("enumerate", args[0]!).map((value, at) => {
        const entry = Object.create(null) as Record<string, CelValue>;
        entry.index = BigInt(at);
        entry.value = value;
        return entry as CelRecord;
      }),
    ),
  ],
  ["compact(list<dyn>)", own((args) => compacted(args[0]!))],
  ["compact(map<dyn, dyn>)", own((args) => compacted(args[0]!))],
  [
    "merge(map<dyn, dyn>, map<dyn, dyn>)",
    own((args) =>
      mapOfEntries(args[0]!, [...mapEntries("merge", args[0]!), ...mapEntries("merge", args[1]!)]),
    ),
  ],
  // One body over the three: the overloads exist so that a statically wrong receiver is a
  // type error, and at runtime a `dyn` receiver reaches whichever of them resolved first, so
  // the VALUE decides what is sliced.
  ["slice(bytes, int, int)", own(sliced)],
  ["slice(string, int, int)", own(sliced)],
  ["slice(list<dyn>, int, int)", own(sliced)],

  // strings
  ["lower(string)", own((args) => text(args[0]!).toLowerCase())],
  ["upper(string)", own((args) => text(args[0]!).toUpperCase())],
  ["trim(string)", own((args) => text(args[0]!).trim())],
  ["replace(string, string, string)", own((args) => text(args[0]!).split(text(args[1]!)).join(text(args[2]!)))],
  ["split(string, string)", own((args) => text(args[0]!).split(text(args[1]!)))],
  [
    "trimPrefix(string, string)",
    own((args) => {
      const prefix = text(args[1]!);
      return text(args[0]!).startsWith(prefix) ? text(args[0]!).slice(prefix.length) : args[0]!;
    }),
  ],
  [
    "trimSuffix(string, string)",
    own((args) => {
      const suffix = text(args[1]!);
      const value = text(args[0]!);
      return suffix !== "" && value.endsWith(suffix) ? value.slice(0, value.length - suffix.length) : value;
    }),
  ],
  [
    "regexReplace(string, string, string)",
    own((args) => pattern("regexReplace", args[1]!, undefined).matcher(text(args[0]!)).replaceAll(text(args[2]!))),
  ],
  [
    "regexReplace(string, string, string, string)",
    own((args) => pattern("regexReplace", args[1]!, args[3]!).matcher(text(args[0]!)).replaceAll(text(args[2]!))),
  ],
  ["regexExtract(string, string)", own((args) => firstMatch("regexExtract", args, undefined))],
  ["regexExtract(string, string, string)", own((args) => firstMatch("regexExtract", args, args[2]!))],
  ["regexExtractAll(string, string)", own((args) => everyMatch("regexExtractAll", args, undefined))],
  ["regexExtractAll(string, string, string)", own((args) => everyMatch("regexExtractAll", args, args[2]!))],
  ["regexGroups(string, string)", own((args) => matchGroups("regexGroups", args, undefined))],
  ["regexGroups(string, string, string)", own((args) => matchGroups("regexGroups", args, args[2]!))],

  // math
  ["abs(dyn)", own((args) => Math.abs(numberOf(args[0]!)))],
  ["floor(dyn)", own((args) => Math.floor(numberOf(args[0]!)))],
  ["ceil(dyn)", own((args) => Math.ceil(numberOf(args[0]!)))],
  // Both arities go through `formattable`, so the 2^53 refusal does not depend on which
  // one the author wrote: guarding only the two-argument form left `round(x)` silently
  // answering with a neighbouring integer, reachable by writing one fewer argument.
  ["round(double)", own((args) => Math.round(formattable("round", args[0]!)))],
  ["round(int)", own((args) => Math.round(formattable("round", args[0]!)))],
  ["round(double, int)", own((args) => roundedTo(args))],
  ["round(int, int)", own((args) => roundedTo(args))],
  ["min(list<dyn>)", own((args) => smallest(list("min", args[0]!), true))],
  ["max(list<dyn>)", own((args) => smallest(list("max", args[0]!), false))],
  [
    "sum(list<dyn>)",
    own((args) => list("sum", args[0]!).reduce((total: number, held) => total + numberOf(held), 0)),
  ],
  [
    "avg(list<dyn>)",
    own((args) => {
      const values = list("avg", args[0]!);
      if (values.length === 0) return null;
      return values.reduce((total: number, held) => total + numberOf(held), 0) / values.length;
    }),
  ],

  // JSON
  ["json(dyn)", hosted("json", (handler) => (args) => handler(args[0]!))],
  ["parseJson(string)", own((args) => parseJsonText(text(args[0]!)))],

  // paths
  [
    "string.joinPath(string)",
    hosted("joinPath", (handler) => (args) => handler(text(args[0]!), text(args[1]!))),
  ],

  // encoding
  ["base64Encode(string)", hosted("base64Encode", (handler) => (args) => handler(text(args[0]!)))],
  ["base64Decode(string)", hosted("base64Decode", (handler) => (args) => handler(text(args[0]!)))],
  ["bytesFromBase64(string)", own((args) => bytesFromBase64(text(args[0]!)))],
  ["bytesToBase64(bytes)", own((args) => base64Text(bytes(args[0]!)))],
  ["urlEncode(string)", own((args) => encodeURIComponent(text(args[0]!)))],
  ["urlDecode(string)", own((args) => decodeURIComponent(text(args[0]!)))],

  // hashing
  ["sha256(string)", hosted("sha256", (handler) => (args) => handler(text(args[0]!)))],
  ["md5(string)", hosted("md5", (handler) => (args) => handler(text(args[0]!)))],
  ["sha1(string)", hosted("sha1", (handler) => (args) => handler(text(args[0]!)))],
  ["sha512(string)", hosted("sha512", (handler) => (args) => handler(text(args[0]!)))],
  [
    "hmac(string, string, string)",
    hosted("hmac", (handler) => (args) => handler(text(args[0]!), text(args[1]!), text(args[2]!))),
  ],

  // null handling
  ["default(dyn, dyn)", own((args) => (args[0] === null ? args[1]! : args[0]!))],
  [
    "coalesce(list<dyn>)",
    own((args) => {
      const found = list("coalesce", args[0]!).find((held) => held !== null);
      return found === undefined ? null : found;
    }),
  ],

  // time
  ["now()", own(() => instantOfMillis("now", Date.now()))],
  ["nowIso()", own(() => isoTextIn(Date.now(), "UTC"))],
  ["nowIso(string)", own((args) => isoTextIn(Date.now(), zoneArg("nowIso", args[0]!)))],
  ["today()", own(() => dateTextIn(Date.now(), "UTC"))],
  ["today(string)", own((args) => dateTextIn(Date.now(), zoneArg("today", args[0]!)))],
  ["nowMillis()", own(() => BigInt(Date.now()))],
  ["nowSeconds()", own(() => BigInt(Math.floor(Date.now() / 1000)))],
  ["dateIn(google.protobuf.Timestamp)", own((args) => dateIn(args, undefined))],
  ["dateIn(google.protobuf.Timestamp, string)", own((args) => dateIn(args, args[1]!))],
  ["isoIn(google.protobuf.Timestamp)", own((args) => isoIn(args, undefined))],
  ["isoIn(google.protobuf.Timestamp, string)", own((args) => isoIn(args, args[1]!))],
  ["startOfMonth(google.protobuf.Timestamp)", own((args) => startOfMonth(args, undefined))],
  ["startOfMonth(google.protobuf.Timestamp, string)", own((args) => startOfMonth(args, args[1]!))],
  ["addMonths(google.protobuf.Timestamp, int)", own((args) => addMonths(args, undefined))],
  ["addMonths(google.protobuf.Timestamp, int, string)", own((args) => addMonths(args, args[2]!))],

  // formatting
  ["format(double, string)", own((args) => formatter("format", args[1]!)(formattable("format", args[0]!)))],
  ["format(int, string)", own((args) => formatter("format", args[1]!)(formattable("format", args[0]!)))],
  ["fixed(double, int)", own((args) => fixedText(args))],
  ["fixed(int, int)", own((args) => fixedText(args))],
  ["formatDuration(double, int)", own((args) => durationText(args[0]!, args[1]!))],
  ["formatDuration(int, int)", own((args) => durationText(args[0]!, args[1]!))],

  // uuid
  ["uuidv1()", own(() => v1())],
  ["uuidv4()", own(() => v4())],
  ["uuidv6()", own(() => v6())],
  ["uuidv7()", own(() => v7())],
  ["uuidv3(string, string)", own((args) => v3(text(args[0]!), text(args[1]!)))],
  ["uuidv5(string, string)", own((args) => v5(text(args[0]!), text(args[1]!)))],
  ["uuidValidate(string)", own((args) => uuidValidate(text(args[0]!)))],
  ["uuidVersion(string)", own((args) => BigInt(uuidVersion(text(args[0]!))))],
]);

/**
 * The half-open range of a string, bytes or a list. Indices arrive as CEL ints (`bigint`),
 * which neither `String.slice` nor `TypedArray.subarray` accepts. `subarray` rather than
 * `slice` for bytes: a view costs no copy, and every consumer treats the result as read-only.
 */
function sliced(args: readonly CelValue[]): CelValue {
  const from = Number(args[1] as bigint);
  const to = Number(args[2] as bigint);
  const value = args[0]!;
  if (typeof value === "string") return value.slice(from, to);
  if (isCelBytes(value)) return value.subarray(from, to);
  if (Array.isArray(value)) return value.slice(from, to);
  throw new CatalogRefusal(
    `slice: expected a string, bytes or a list, got ${celTypeNameOf(value) ?? "no CEL value"}`,
  );
}

function roundedTo(args: readonly CelValue[]): number {
  return Number(formattable("round", args[0]!).toFixed(digitCount("round", args[1]!)));
}

function fixedText(args: readonly CelValue[]): string {
  return formatter("fixed", `.${digitCount("fixed", args[1]!)}f`)(formattable("fixed", args[0]!));
}

function firstMatch(what: string, args: readonly CelValue[], flags: CelValue | undefined): string {
  const matcher = pattern(what, args[1]!, flags).matcher(text(args[0]!));
  return matcher.find() ? (matcher.group() ?? "") : "";
}

function everyMatch(what: string, args: readonly CelValue[], flags: CelValue | undefined): string[] {
  const matcher = pattern(what, args[1]!, flags).matcher(text(args[0]!));
  const out: string[] = [];
  while (matcher.find()) out.push(matcher.group() ?? "");
  return out;
}

function matchGroups(what: string, args: readonly CelValue[], flags: CelValue | undefined): string[] {
  const matcher = pattern(what, args[1]!, flags).matcher(text(args[0]!));
  if (!matcher.find()) return [];
  return Array.from({ length: matcher.groupCount() }, (_unused, at) => matcher.group(at + 1) ?? "");
}

function dateIn(args: readonly CelValue[], zone: CelValue | undefined): string {
  return dateTextIn(millisOf(instantArg("dateIn", args[0]!)), zoneArg("dateIn", zone));
}

function isoIn(args: readonly CelValue[], zone: CelValue | undefined): string {
  return isoTextIn(millisOf(instantArg("isoIn", args[0]!)), zoneArg("isoIn", zone));
}

function startOfMonth(args: readonly CelValue[], zone: CelValue | undefined): CelValue {
  const named = zoneArg("startOfMonth", zone);
  const fields = civilTimeIn(millisOf(instantArg("startOfMonth", args[0]!)), named);
  return instantOfMillis(
    "startOfMonth",
    instantOfCivilTime({ ...fields, day: 1, hour: 0, minute: 0, second: 0 }, named),
  );
}

function addMonths(args: readonly CelValue[], zone: CelValue | undefined): CelValue {
  const named = zoneArg("addMonths", zone);
  const fields = civilTimeIn(millisOf(instantArg("addMonths", args[0]!)), named);
  const shifted = fields.year * 12 + (fields.month - 1) + Number(args[1] as bigint);
  // `%` takes the dividend's sign in JS, so a negative total would yield month 0.
  const year = Math.floor(shifted / 12);
  const month = (((shifted % 12) + 12) % 12) + 1;
  return instantOfMillis(
    "addMonths",
    instantOfCivilTime({ ...fields, year, month, day: Math.min(fields.day, daysInMonth(year, month)) }, named),
  );
}

/**
 * The implementation of a catalog signature, given the host's handlers, or nothing where
 * the catalog declares no such call. A declaration with no behaviour here is refused at
 * registration rather than at evaluation.
 */
export function catalogImplementation(
  key: string,
  handlers: Partial<CelCatalogHandlers>,
): CelImplementation | undefined {
  return IMPLEMENTATIONS.get(key)?.(handlers);
}

/** Every dispatch key this file answers for, for a completeness check. */
export function catalogImplementedKeys(): readonly string[] {
  return [...IMPLEMENTATIONS.keys()];
}

// --- the literal guards -----------------------------------------------------

/**
 * The guards, over the arguments a call wrote as literals. The contract — which positions
 * a guard is handed, and that it must skip an `undefined` — is `LiteralArgumentCheck`'s,
 * in `signature.ts`, where the checker reads it. What is written here is only which
 * function refuses what, and each guard runs the very code the evaluation runs.
 */

/** Runs a guard for its refusal alone. Anything else it throws is this engine failing. */
function refusalOf(run: () => void): string | undefined {
  try {
    run();
    return undefined;
  } catch (cause) {
    if (cause instanceof CatalogRefusal) return cause.message;
    throw cause;
  }
}

/** A regex function's guard: the flags and the pattern, each judged only as a literal. */
const regexGuard =
  (what: string, patternAt: number, flagsAt: number): LiteralArgumentCheck =>
  (literals) =>
    refusalOf(() => {
      const flags = literals[flagsAt];
      const bits = typeof flags === "string" ? re2Flags(what, flags) : 0;
      const written = literals[patternAt];
      if (typeof written === "string") patternOrRefusal(what, written, bits);
    });

const LITERAL_CHECKS = new Map<string, LiteralArgumentCheck>([
  ["regexReplace", regexGuard("regexReplace", 1, 3)],
  ["regexExtract", regexGuard("regexExtract", 1, 2)],
  ["regexExtractAll", regexGuard("regexExtractAll", 1, 2)],
  ["regexGroups", regexGuard("regexGroups", 1, 2)],
  [
    "round",
    (literals) =>
      refusalOf(() => {
        if (literals[1] !== undefined) digitCount("round", literals[1]);
        if (typeof literals[0] === "bigint") formattable("round", literals[0]);
      }),
  ],
  [
    "format",
    (literals) =>
      refusalOf(() => {
        if (literals[1] !== undefined) formatter("format", literals[1]);
        if (typeof literals[0] === "bigint") formattable("format", literals[0]);
      }),
  ],
  [
    "fixed",
    (literals) =>
      refusalOf(() => {
        if (literals[1] !== undefined) digitCount("fixed", literals[1]);
        if (typeof literals[0] === "bigint") formattable("fixed", literals[0]);
      }),
  ],
  [
    "formatDuration",
    (literals) =>
      refusalOf(() => {
        if (literals[1] !== undefined) durationText(literals[0] ?? 0n, literals[1]);
      }),
  ],
  ["dateIn", zoneGuard("dateIn", 1)],
  ["isoIn", zoneGuard("isoIn", 1)],
  ["startOfMonth", zoneGuard("startOfMonth", 1)],
  ["addMonths", zoneGuard("addMonths", 2)],
]);

function zoneGuard(what: string, at: number): LiteralArgumentCheck {
  return (literals) =>
    refusalOf(() => {
      if (typeof literals[at] === "string") zoneArg(what, literals[at]);
    });
}

/** The literal guard of a catalog function, where it has one. */
export function catalogLiteralCheck(name: string): LiteralArgumentCheck | undefined {
  return LITERAL_CHECKS.get(name);
}

/** Every function name a literal guard answers for, for a completeness check. */
export function catalogGuardedNames(): readonly string[] {
  return [...LITERAL_CHECKS.keys()];
}
