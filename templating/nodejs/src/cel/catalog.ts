import { formatLocale } from "d3-format";
import { RE2JS } from "re2js";
import { v1, v3, v4, v5, v6, v7, validate as uuidValidate, version as uuidVersion } from "uuid";

/** Host-injected functions that need platform APIs the templating package must
 *  not import directly (Node `crypto` / `Buffer`), keeping it browser-safe. The
 *  kernel supplies real implementations; the analyzer omits them (the stubs
 *  throw, since static analysis never executes these). */
export interface CelHandlers {
  sha256: (s: string) => string;
  md5: (s: string) => string;
  sha1: (s: string) => string;
  sha512: (s: string) => string;
  hmac: (algorithm: string, key: string, message: string) => string;
  base64Encode: (s: string) => string;
  base64Decode: (s: string) => string;
  json: (value: unknown) => string;
}

/** RE2 regex engine for the CEL `regex*` functions — `re2js`, a pure-JS port of
 *  Google's RE2. The dialect is RE2 (linear-time, no backtracking, ReDoS-safe) —
 *  never JS `RegExp` — so a manifest's regex behaves the same across runtimes.
 *  Flags map a trailing option string to RE2 flags; inline `(?s)` etc. work in
 *  the pattern too.
 *
 *  Why pure-JS and not a native RE2:
 *  - The Rust `regex` crate via napi (N-API) is faster, but shipping it means a
 *    cross-platform prebuild matrix + per-triple npm packages — a whole release
 *    subsystem for one function family.
 *  - The `re2` npm package (Google's C++ RE2) is simpler to depend on, but it's a
 *    nan/V8 addon and **does not load under Bun** (incomplete V8 C++ ABI →
 *    `undefined symbol`). Telo's CLI and test suite run on Bun, so that's a
 *    non-starter.
 *  `re2js` is pure JS: zero native addons, runs identically on Node, Bun, and the
 *  browser (keeps this package — and the analyzer — browser-safe), and needs no
 *  prebuilds. The cost is throughput vs. native, which is irrelevant for the
 *  small strings CEL manifests run regex over. */
const RE2_FLAG: Record<string, number> = {
  i: RE2JS.CASE_INSENSITIVE,
  m: RE2JS.MULTILINE,
  s: RE2JS.DOTALL,
};

const compileRe2 = (fn: string, pattern: string, flags?: string): RE2JS => {
  let bits = 0;
  for (const c of flags ?? "") {
    if (c === "g") continue; // global is implicit in replaceAll / find-loop
    const bit = RE2_FLAG[c];
    if (bit === undefined) throw new Error(`${fn}: unknown regex flag '${c}' (supported: i, m, s)`);
    bits |= bit;
  }
  try {
    return RE2JS.compile(pattern, bits);
  } catch (e) {
    throw new Error(
      `${fn}: invalid RE2 pattern ${JSON.stringify(pattern)}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
};

export type CelFunctionCategory =
  | "conversion"
  | "time"
  | "uuid"
  | "string"
  | "math"
  | "collection"
  | "json"
  | "encoding"
  | "hashing"
  | "formatting"
  | "null";

/** One entry in the CEL standard library — the single source of truth that both
 *  registers the function (`build`) and documents it (everything else). `telo
 *  cel functions` and `celFunctionCatalog()` read the metadata; `buildCelEnvironment`
 *  calls `build`. */
export interface CelFunctionDoc {
  /** Bare function name (`nowIso`, `uuidv4`). */
  readonly name: string;
  /** Human-facing signature for docs (`nowIso(tz?): string`). May use `?` for
   *  optional args even though cel-js itself has no optional syntax. */
  readonly signature: string;
  /** Actual cel-js signatures to register — one per arity for an overloaded
   *  function. When omitted, `deriveSignatures(signature)` is used: if the
   *  signature contains `type?`-marked optional params (e.g. `fn(string?): T`),
   *  it auto-expands to one registration per arity. Set `register` explicitly
   *  only when the auto-derivation is insufficient. */
  readonly register?: readonly string[];
  readonly category: CelFunctionCategory;
  readonly summary: string;
  /** False → re-evaluates per call; in an `x-telo-eval: compile` field it bakes
   *  once at load. */
  readonly deterministic: boolean;
  /** Needs a `CelHandlers` implementation (Node `crypto` / `Buffer`); the
   *  analyzer's stub throws if such a function is actually evaluated. */
  readonly hostBacked: boolean;
  readonly build: (h: CelHandlers) => (...args: any[]) => unknown;
  /**
   * Check the arguments that were written as LITERALS, at analysis time.
   *
   * A type is all a signature can constrain, so a guard over a value —
   * an unparseable format specifier, a decimal count out of range, a day length
   * of zero, an unknown IANA zone — fires only when the expression is evaluated.
   * That puts a defect the manifest states in plain sight behind a run, which is
   * the opposite of what static analysis is for.
   *
   * `literals[i]` is the value of argument `i` when it was written as a literal,
   * and `undefined` when it is an expression whose value is not statically
   * known — so a checker MUST skip an `undefined` rather than judge it.
   * Returns a message, or `undefined` when there is nothing to report.
   *
   * Implementations call the SAME guard the runtime calls, so the static and
   * dynamic answers cannot drift into disagreement.
   */
  readonly checkArgs?: (literals: readonly unknown[]) => string | undefined;
}

/** Run a runtime guard for its refusal, so a `checkArgs` never restates one. */
const literalGuard = (run: () => void): string | undefined => {
  try {
    run();
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

/** Public, build-free view of a catalog entry (for `--json` / docs). */
export type CelFunctionInfo = Omit<CelFunctionDoc, "build">;

const num = (x: unknown): number => Number(x);

const minMax = (list: unknown[], isMin: boolean): unknown => {
  if (!Array.isArray(list) || list.length === 0) return null;
  let best = list[0];
  let bestN = num(best);
  for (const x of list) {
    const n = num(x);
    if (isMin ? n < bestN : n > bestN) {
      best = x;
      bestN = n;
    }
  }
  return best;
};

const sortList = (list: unknown[]): unknown[] =>
  [...list].sort((a, b) => {
    if (typeof a === "number" || typeof a === "bigint") {
      const d = num(a) - num(b);
      return d < 0 ? -1 : d > 0 ? 1 : 0;
    }
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  });

/** The number-formatting locale, pinned rather than defaulted.
 *
 *  d3-format's default locale renders a negative with U+2212 MINUS SIGN, so
 *  `format(-1.5, '.2f')` is `"−1.50"` and not `"-1.50"` — a string that no
 *  downstream parser, comparison or diff treats as the number it looks like.
 *  Every field here is fixed to its ASCII form for the same reason the layer is
 *  locale-free at all: the same manifest must render the same bytes on every
 *  runtime, and a second engine implementing the specifier grammar has to be
 *  able to reproduce these exactly. */
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

/** A CEL `int` is a BigInt in this runtime and `d3-format` throws on one
 *  outright, so a formattable argument is converted here. Past 2^53 a double
 *  stops representing every integer, and silently emitting a number that is not
 *  the one the author computed is the defect class this family exists to close —
 *  so that case raises instead. */
const formattable = (fn: string, x: unknown): number => {
  if (typeof x === "bigint") {
    if (x > MAX_EXACT_INT || x < -MAX_EXACT_INT) {
      throw new Error(
        `${fn}: integer ${x} exceeds 2^53-1 and cannot be formatted exactly as a double`,
      );
    }
    return Number(x);
  }
  const n = Number(x);
  // The runtime backstop behind the typed registrations. A value that is not a
  // number formats as the string "NaN", which is the failure this family exists
  // to remove: it looks like an answer and prints into a document. Named here
  // rather than coerced, the way an instant argument is.
  if (!Number.isFinite(n)) {
    throw new Error(`${fn}: expected a finite number, got ${JSON.stringify(x)}`);
  }
  return n;
};

/** Specifier type characters d3 implements. An unknown one PARSES — `.2q`
 *  yields `"1"` rather than throwing — so a typo would silently format against
 *  the default type. The set is checked here so a bad specifier is refused
 *  rather than quietly answered. */
const FORMAT_TYPES = new Set([..."efgrs%pbodxXcn"]);

/** A specifier is a CEL value, so it can be request-derived — an `Http.Server`
 *  evaluating `format(x, request.query.spec)` would otherwise grow this map for
 *  the life of the process, and it is module-global, so every in-process kernel
 *  shares it. Cleared wholesale at the cap rather than evicted one at a time: a
 *  manifest's real specifier set is a handful of constants that repopulate
 *  immediately, and an LRU is machinery for a hit rate nothing here needs. */
const FORMATTER_CACHE_MAX = 256;
const formatterCache = new Map<string, (n: number) => string>();

const formatter = (fn: string, spec: unknown): ((n: number) => string) => {
  const text = String(spec);
  const cached = formatterCache.get(text);
  if (cached) return cached;
  const type = text.slice(-1);
  if (text !== "" && /[a-zA-Z%]/.test(type) && !FORMAT_TYPES.has(type)) {
    throw new Error(`${fn}: unknown format type '${type}' (one of ${[...FORMAT_TYPES].join("")})`);
  }
  // The `.precision` group — width is the digits BEFORE the dot, so this is the
  // only `.`-digits sequence the grammar admits.
  const precision = /\.(\d+)/.exec(text);
  if (precision) digitCount(fn, precision[1]);
  let built: (n: number) => string;
  try {
    built = FORMAT_LOCALE.format(text);
  } catch {
    throw new Error(`${fn}: invalid format specifier ${JSON.stringify(text)}`);
  }
  if (formatterCache.size >= FORMATTER_CACHE_MAX) formatterCache.clear();
  formatterCache.set(text, built);
  return built;
};

/** Decimal places, bounded. The ceiling is well below what `toFixed` accepts
 *  because past it the digits are an artefact of the binary representation
 *  rather than of the value.
 *
 *  ONE rule, enforced wherever a precision is written: `formatter` applies it to
 *  a specifier's `.precision` group too. Bounding only this spelling let an
 *  author route around the guard by writing `format(x, '.11f')` instead of
 *  `fixed(x, 11)` — the family giving two answers to one question. It is not the
 *  grammar subsetting the "full d3 surface" decision refuses: every specifier
 *  type and flag stays available, and only the digit count is capped. */
const MAX_DECIMALS = 10;

const digitCount = (fn: string, digits: unknown): number => {
  const n = Number(digits);
  if (!Number.isInteger(n) || n < 0 || n > MAX_DECIMALS) {
    throw new Error(
      `${fn}: decimal places must be an integer 0-${MAX_DECIMALS}, got ${String(digits)}`,
    );
  }
  return n;
};

/** Render a minute count against a declared day length. The day is a policy
 *  argument, never an assumption — see the catalog entry's summary. */
const durationText = (minutes: unknown, minutesPerDay: unknown): string => {
  const perDay = Math.round(formattable("formatDuration", minutesPerDay));
  if (!Number.isFinite(perDay) || perDay <= 0) {
    throw new Error(`formatDuration: minutesPerDay must be a positive number, got ${perDay}`);
  }
  const total = Math.round(formattable("formatDuration", minutes));
  if (!Number.isFinite(total)) {
    throw new Error(`formatDuration: minutes must be a finite number`);
  }
  const magnitude = Math.abs(total);
  const days = Math.floor(magnitude / perDay);
  const withinDay = magnitude % perDay;
  const hours = Math.floor(withinDay / 60);
  const mins = withinDay % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (mins) parts.push(`${mins}m`);
  if (parts.length === 0) parts.push("0m");
  return `${total < 0 ? "-" : ""}${parts.join(" ")}`;
};

/** Refuse an unknown zone in this family's own voice. Left to `Intl`, the
 *  failure is a raw `RangeError` naming neither the function nor what was
 *  wrong with the argument — the only refusal here that did not read
 *  `<fn>: <what is wrong>`, and whose wording belongs to the JS engine rather
 *  than to Telo. Also the guard `checkArgs` runs at analysis time, so a literal
 *  zone is checked once and answered identically in both places. */
const assertZone = (fn: string, tz: string): string => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error(`${fn}: unknown IANA time zone ${JSON.stringify(tz)}`);
  }
  return tz;
};

/** `Intl.DateTimeFormat` is an ECMA-402 global in Node (full ICU) and browsers,
 *  so timezone handling needs no Node-only API and stays browser-safe. */
const zoneParts = (date: Date, tz: string, opts: Intl.DateTimeFormatOptions): Record<string, string> => {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts }).formatToParts(date)) {
    parts[p.type] = p.value;
  }
  return parts;
};

/** Current instant as ISO-8601 in `tz`: UTC `…Z` for "UTC", else the zone's
 *  offset (e.g. `2026-06-06T18:30:00.000-05:00`). Uses only standard Intl
 *  fields and derives the offset arithmetically, so it needs no newer Intl
 *  type-lib features and stays portable. */
const isoInZone = (now: Date, tz: string): string => {
  if (tz === "UTC" || tz === "Z") return now.toISOString();
  const p = zoneParts(now, tz, {
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  // Sub-second is timezone-independent; read it off the instant directly.
  const ms = String(now.getUTCMilliseconds()).padStart(3, "0");
  // Offset = the zone's wall-clock read as UTC, minus the real instant.
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const offsetMin = Math.round((asUtc - now.getTime()) / 60000);
  const offset =
    offsetMin === 0
      ? "Z"
      : `${offsetMin > 0 ? "+" : "-"}${String(Math.floor(Math.abs(offsetMin) / 60)).padStart(2, "0")}:${String(Math.abs(offsetMin) % 60).padStart(2, "0")}`;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.${ms}${offset}`;
};

/** Calendar date (`YYYY-MM-DD`) of an instant in `tz`. */
const dateInZone = (now: Date, tz: string): string => {
  if (tz === "UTC" || tz === "Z") return now.toISOString().slice(0, 10);
  const p = zoneParts(now, tz, { year: "numeric", month: "2-digit", day: "2-digit" });
  return `${p.year}-${p.month}-${p.day}`;
};

/** An instant is only a date once a zone is chosen, so every calendar function
 *  reads its fields through one of these. `Intl` rejects an unknown zone, which
 *  is what turns a typo into an error rather than a silently-UTC answer. */
interface ZonedFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const zonedFields = (date: Date, tz: string): ZonedFields => {
  const p = zoneParts(date, tz, {
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return {
    year: +p.year!,
    month: +p.month!,
    day: +p.day!,
    hour: +p.hour!,
    minute: +p.minute!,
    second: +p.second!,
  };
};

/** The zone's offset at `date`, in milliseconds — its wall clock read as UTC,
 *  minus the real instant. The same arithmetic `isoInZone` does. */
const zoneOffsetMs = (date: Date, tz: string): number => {
  const f = zonedFields(date, tz);
  return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) - date.getTime();
};

const sameWallClock = (a: ZonedFields, b: ZonedFields): boolean =>
  a.year === b.year &&
  a.month === b.month &&
  a.day === b.day &&
  a.hour === b.hour &&
  a.minute === b.minute &&
  a.second === b.second;

/** The instant whose wall clock in `tz` is the given fields.
 *
 *  The offset depends on the instant being solved for, so this takes the offset
 *  at the UTC reading, corrects, and then CHECKS by reading the result back.
 *  That check is the whole point: a plain fixpoint settles on an instant whose
 *  wall clock is not the one asked for whenever the requested time does not
 *  exist, and it settles BACKWARDS — which silently moves the calendar day, the
 *  one thing `addMonths` and `startOfMonth` exist to control. Chile jumps
 *  00:00 → 01:00 on 2026-09-06 and Cuba on 2026-03-08, so "the 6th at midnight"
 *  there is not a time; a fixpoint answered "the 5th at 23:00".
 *
 *  Resolution follows Java's `ZonedDateTime` and Temporal's `compatible`:
 *  a wall clock that exists twice (a fall-back) takes the EARLIER instant, and
 *  one that does not exist (a spring-forward gap) shifts FORWARD out of the gap,
 *  which keeps the requested day. */
const instantOfZoned = (f: ZonedFields, tz: string): Date => {
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  const offsetA = zoneOffsetMs(new Date(asUtc), tz);
  const candidateA = asUtc - offsetA;
  const offsetB = zoneOffsetMs(new Date(candidateA), tz);
  if (offsetA === offsetB) return new Date(candidateA);

  const candidateB = asUtc - offsetB;
  const aHolds = sameWallClock(zonedFields(new Date(candidateA), tz), f);
  const bHolds = sameWallClock(zonedFields(new Date(candidateB), tz), f);
  if (aHolds && bHolds) return new Date(Math.min(candidateA, candidateB));
  if (aHolds) return new Date(candidateA);
  if (bHolds) return new Date(candidateB);
  return new Date(Math.max(candidateA, candidateB));
};

/** `Date.UTC` maps years 0-99 to 1900-1999, so the year is set explicitly. */
const daysInMonth = (year: number, month: number): number => {
  const d = new Date(Date.UTC(2000, month, 0));
  d.setUTCFullYear(year, month, 0);
  return d.getUTCDate();
};

/** An instant argument arrives as a `Date`; anything else is a caller error the
 *  type-checker did not catch (a `dyn` slot), so it is named rather than
 *  coerced into an Invalid Date that formats as `NaN`. */
const instantArg = (fn: string, v: unknown): Date => {
  if (v instanceof Date && Number.isFinite(v.getTime())) return v;
  throw new Error(`${fn}: expected a timestamp`);
};

/** Drop entries whose value is null or the empty string. Nothing else: an empty
 *  list or map is a value someone deliberately built. CEL hands a map over as a
 *  plain object or a `Map` depending on how it was produced, so both are read. */
const compactValue = (v: unknown): unknown => {
  const keep = (x: unknown): boolean => x !== null && x !== undefined && x !== "";
  if (Array.isArray(v)) return v.filter(keep);
  if (v instanceof Map) {
    return new Map([...v.entries()].filter(([, value]) => keep(value)));
  }
  // A PLAIN object only. Rebuilding an arbitrary object from its entries is how
  // a byte buffer becomes `{"0":137,…}` and an instant becomes `{}` — silently,
  // and looking like a value. The same rule the compile walker follows, and the
  // same "name it rather than coerce it" the instant argument follows.
  if (v !== null && typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`compact: expected a map or a list, got ${v.constructor?.name ?? "an object"}`);
    }
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, value]) => keep(value)));
  }
  throw new Error(`compact: expected a map or a list, got ${JSON.stringify(v)}`);
};

/** A CEL map as entries. Read the way `compact` reads one — a map arrives as a
 *  plain object or a `Map` depending on how it was produced — and refusing
 *  anything that is not one, since rebuilding an arbitrary object from its
 *  entries is how a byte buffer becomes `{"0":137,…}` silently. A LIST is named
 *  rather than coerced: CEL's `+` already concatenates lists, so a list here is
 *  a mistake with a spelling that works, not a case to support. */
const mapEntries = (fn: string, v: unknown): [string, unknown][] => {
  if (v instanceof Map) return [...v.entries()] as [string, unknown][];
  if (Array.isArray(v)) throw new Error(`${fn}: expected a map, got a list — use '+' to join lists`);
  if (v !== null && typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`${fn}: expected a map, got ${v.constructor?.name ?? "an object"}`);
    }
    return Object.entries(v as Record<string, unknown>);
  }
  throw new Error(`${fn}: expected a map, got ${JSON.stringify(v)}`);
};

/** Right-hand precedence, so `merge(defaults, overrides)` reads as it looks.
 *
 *  The map case is the one with no spelling at all — `+` joins lists and
 *  strings and refuses maps — so a child kind inheriting a map-valued field
 *  could only REPLACE it. That turns a default the parent set for a reason into
 *  something every consumer must restate, and a consumer who restates it
 *  incompletely gets a system that works until the omitted entry matters.
 *
 *  Follows the LEFT argument's shape: this extends that map, so what comes back
 *  is what was extended. */
const mergeMaps = (a: unknown, b: unknown): unknown => {
  const entries = [...mapEntries("merge", a), ...mapEntries("merge", b)];
  return a instanceof Map ? new Map(entries) : Object.fromEntries(entries);
};

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 → bytes, written out rather than delegated: `Buffer` is not browser-
 *  safe and `atob` round-trips through a string, which is the corruption this
 *  pair exists to avoid. Accepts the URL-safe alphabet and tolerates missing
 *  padding, both of which appear in real API payloads; a character outside the
 *  alphabet is a hard error rather than a silently dropped byte. */
function decodeBase64ToBytes(input: string): Uint8Array {
  const clean = input.replace(/[\r\n\t ]/g, "").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  // A remainder of 1 cannot come from any byte sequence: base64 encodes 3 bytes
  // as 4 characters, so the valid remainders are 0, 2 and 3. Left to the loop it
  // would leave 6 bits unwritten and return a SHORT buffer — the silently dropped
  // byte this function refuses for a bad character.
  if (clean.length % 4 === 1) {
    throw new Error("bytesFromBase64: input length is not valid base64");
  }
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let written = 0;
  for (const ch of clean) {
    const value = BASE64_ALPHABET.indexOf(ch);
    if (value < 0) throw new Error(`bytesFromBase64: '${ch}' is not a base64 character`);
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, written);
}

function encodeBytesToBase64(input: Uint8Array): string {
  let out = "";
  for (let i = 0; i < input.length; i += 3) {
    const a = input[i]!;
    const b = i + 1 < input.length ? input[i + 1]! : undefined;
    const c = i + 2 < input.length ? input[i + 2]! : undefined;
    out += BASE64_ALPHABET[a >> 2];
    out += BASE64_ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : BASE64_ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : BASE64_ALPHABET[c & 0x3f];
  }
  return out;
}

export const CEL_FUNCTIONS: readonly CelFunctionDoc[] = [
  // Collections
  {
    name: "join",
    signature: "join(list, string): string",
    category: "collection",
    summary: "Join list elements into a string with a separator.",
    deterministic: true,
    hostBacked: false,
    build: () => (list: unknown[], sep: string) => list.map(String).join(sep),
  },
  {
    name: "keys",
    signature: "keys(map): list",
    category: "collection",
    summary: "List a map's keys.",
    deterministic: true,
    hostBacked: false,
    build: () => (map: unknown) =>
      map instanceof Map ? [...map.keys()] : Object.keys(map as Record<string, unknown>),
  },
  {
    name: "values",
    signature: "values(map): list",
    category: "collection",
    summary: "List a map's values.",
    deterministic: true,
    hostBacked: false,
    build: () => (map: unknown) =>
      map instanceof Map ? [...map.values()] : Object.values(map as Record<string, unknown>),
  },
  {
    name: "distinct",
    signature: "distinct(list): list",
    category: "collection",
    summary: "Remove duplicate elements, preserving order.",
    deterministic: true,
    hostBacked: false,
    build: () => (list: unknown[]) => [...new Set(list)],
  },
  {
    name: "reverse",
    signature: "reverse(list): list",
    category: "collection",
    summary: "Reverse a list (copy; never mutates the input).",
    deterministic: true,
    hostBacked: false,
    build: () => (list: unknown[]) => [...list].reverse(),
  },
  {
    name: "flatten",
    signature: "flatten(list): list",
    category: "collection",
    summary: "Flatten one level of nested lists.",
    deterministic: true,
    hostBacked: false,
    build: () => (list: unknown[]) => list.flat(),
  },
  {
    name: "sort",
    signature: "sort(list): list",
    category: "collection",
    summary: "Sort a list numerically (numbers) or lexicographically; copy.",
    deterministic: true,
    hostBacked: false,
    build: () => (list: unknown[]) => sortList(list),
  },
  {
    name: "range",
    signature: "range(int): list<int>",
    category: "collection",
    summary: "Integers [0, n-1] (empty for n <= 0); materializes indices for an unknown-length list.",
    deterministic: true,
    hostBacked: false,
    build: () => (n: unknown) =>
      Array.from({ length: Math.max(0, Math.trunc(num(n))) }, (_unused, i) => BigInt(i)),
  },
  {
    name: "enumerate",
    signature: "enumerate(list): list",
    category: "collection",
    summary: "Pair each element with its zero-based position as {index, value}.",
    deterministic: true,
    hostBacked: false,
    build: () => (list: unknown[]) =>
      list.map((value, i) => ({ index: BigInt(i), value })),
  },
  // Strings
  {
    name: "lower",
    signature: "lower(string): string",
    category: "string",
    summary: "Lowercase a string.",
    deterministic: true,
    hostBacked: false,
    build: () => (s: string) => s.toLowerCase(),
  },
  {
    name: "upper",
    signature: "upper(string): string",
    category: "string",
    summary: "Uppercase a string.",
    deterministic: true,
    hostBacked: false,
    build: () => (s: string) => s.toUpperCase(),
  },
  {
    name: "trim",
    signature: "trim(string): string",
    category: "string",
    summary: "Strip leading/trailing whitespace.",
    deterministic: true,
    hostBacked: false,
    build: () => (s: string) => s.trim(),
  },
  {
    name: "replace",
    signature: "replace(string, string, string): string",
    category: "string",
    summary: "Replace all occurrences of a substring.",
    deterministic: true,
    hostBacked: false,
    build: () => (s: string, a: string, b: string) => s.split(a).join(b),
  },
  {
    name: "split",
    signature: "split(string, string): list",
    category: "string",
    summary: "Split a string on a separator into a list.",
    deterministic: true,
    hostBacked: false,
    build: () => (s: string, sep: string) => s.split(sep),
  },
  {
    name: "regexReplace",
    signature: "regexReplace(string, string, string, string?): string",
    category: "string",
    summary:
      "Replace every regex match (RE2 syntax) with a replacement ($1 backrefs); flags like 'i', 'm', 's'.",
    deterministic: true,
    hostBacked: false,
    build: () => (s: string, pattern: string, replacement: string, flags?: string) =>
      compileRe2("regexReplace", pattern, flags).matcher(s).replaceAll(replacement),
  },
  {
    name: "regexExtract",
    signature: "regexExtract(string, string, string?): string",
    category: "string",
    summary: "First whole match of a regex (RE2 syntax), or '' when there is none.",
    deterministic: true,
    hostBacked: false,
    build: () => (s: string, pattern: string, flags?: string) => {
      const m = compileRe2("regexExtract", pattern, flags).matcher(s);
      return m.find() ? (m.group() ?? "") : "";
    },
  },
  {
    name: "regexExtractAll",
    signature: "regexExtractAll(string, string, string?): list<string>",
    category: "string",
    summary: "Every whole match of a regex (RE2 syntax), in order.",
    deterministic: true,
    hostBacked: false,
    build: () => (s: string, pattern: string, flags?: string) => {
      const m = compileRe2("regexExtractAll", pattern, flags).matcher(s);
      const out: string[] = [];
      while (m.find()) out.push(m.group() ?? "");
      return out;
    },
  },
  {
    name: "regexGroups",
    signature: "regexGroups(string, string, string?): list<string>",
    category: "string",
    summary:
      "Capture groups of the first regex match (RE2 syntax); empty list when there is no match.",
    deterministic: true,
    hostBacked: false,
    build: () => (s: string, pattern: string, flags?: string) => {
      const m = compileRe2("regexGroups", pattern, flags).matcher(s);
      if (!m.find()) return [];
      return Array.from({ length: m.groupCount() }, (_unused, i) => m.group(i + 1) ?? "");
    },
  },
  {
    name: "trimPrefix",
    signature: "trimPrefix(string, string): string",
    category: "string",
    summary: "Strip a leading prefix if present.",
    deterministic: true,
    hostBacked: false,
    build: () => (s: string, prefix: string) => (s.startsWith(prefix) ? s.slice(prefix.length) : s),
  },
  {
    name: "trimSuffix",
    signature: "trimSuffix(string, string): string",
    category: "string",
    summary: "Strip a trailing suffix if present.",
    deterministic: true,
    hostBacked: false,
    build: () => (s: string, suffix: string) =>
      suffix && s.endsWith(suffix) ? s.slice(0, s.length - suffix.length) : s,
  },
  // One `slice` over the three sequence types rather than three names: CEL
  // already treats `size()` that way, and the alternative teaches an author that
  // slicing bytes is a different operation from slicing a string.
  //
  // OVERLOADED BY PARAMETER TYPE, so a wrong receiver is rejected — `slice(42, 0,
  // 1)` matches nothing. What cannot ALSO be registered is a `dyn` parameter
  // variant: cel-js refuses overloads that overlap, and a `dyn` first parameter
  // overlaps all three. That is why the RETURN is `dyn` rather than the input's
  // own type. A step result whose producer declares no output type is `dyn`, and
  // with concrete returns the checker resolves such a call to whichever overload
  // was registered first and pins the result to it — so slicing an untyped byte
  // buffer came back typed `string`, and a byte consumer downstream reported a
  // mismatch against perfectly valid CEL. Precision on the way out would be lost
  // at the CEL boundary anyway, where type arguments are erased; being wrong
  // about an untyped receiver would not be.
  {
    name: "slice",
    signature: "slice(dyn, int, int): dyn",
    register: [
      "slice(bytes, int, int): dyn",
      "slice(string, int, int): dyn",
      "slice(list, int, int): dyn",
    ],
    // Not "string": it is the one function over strings, bytes AND lists, and the
    // category is what groups it in the generated reference — filing it under
    // strings hides it from the byte and list readers who need it most.
    category: "collection",
    summary: "Take the half-open range [start, end) of a string, bytes or list.",
    deterministic: true,
    hostBacked: false,
    // Indices arrive as BigInt (a CEL int is int64), and both `String.slice` and
    // `TypedArray.subarray` reject one. `subarray` rather than `slice` for bytes:
    // a view costs no copy, and every consumer treats the result as read-only.
    build: () => (value: string | Uint8Array | unknown[], start: bigint, end: bigint) => {
      const from = Number(start);
      const to = Number(end);
      return value instanceof Uint8Array ? value.subarray(from, to) : value.slice(from, to);
    },
  },
  // Math
  {
    name: "abs",
    signature: "abs(dyn): double",
    category: "math",
    summary: "Absolute value.",
    deterministic: true,
    hostBacked: false,
    build: () => (x: unknown) => Math.abs(num(x)),
  },
  {
    name: "floor",
    signature: "floor(dyn): double",
    category: "math",
    summary: "Round down to an integer.",
    deterministic: true,
    hostBacked: false,
    build: () => (x: unknown) => Math.floor(num(x)),
  },
  {
    name: "ceil",
    signature: "ceil(dyn): double",
    category: "math",
    summary: "Round up to an integer.",
    deterministic: true,
    hostBacked: false,
    build: () => (x: unknown) => Math.ceil(num(x)),
  },
  {
    name: "round",
    signature: "round(dyn, int?): double",
    register: [
      "round(double): double",
      "round(int): double",
      "round(double, int): double",
      "round(int, int): double",
    ],
    category: "math",
    summary:
      "Round to the nearest integer, or to the given number of decimal places (0–10). The two-argument form shares the formatter's rounding rule, so a rounded value and the cell rendered beside it agree at the boundary. An integer past 2^53 is refused rather than rounded to a neighbour.",
    deterministic: true,
    hostBacked: false,
    // Both arities go through `formattable`, so the 2^53 refusal does not depend
    // on which one the author wrote. Guarding only the two-argument form left
    // `round(x)` silently answering with a neighbouring integer — the defect
    // this family exists to close, reachable by writing one fewer argument.
    build: () => (x: unknown, digits?: unknown) =>
      digits === undefined
        ? Math.round(formattable("round", x))
        : Number(formattable("round", x).toFixed(digitCount("round", digits))),
    checkArgs: (lit) =>
      literalGuard(() => {
        if (lit[1] !== undefined) digitCount("round", lit[1]);
        if (typeof lit[0] === "bigint") formattable("round", lit[0]);
      }),
  },
  {
    name: "min",
    signature: "min(list): dyn",
    category: "math",
    summary: "Smallest element (by numeric value); null for an empty list.",
    deterministic: true,
    hostBacked: false,
    build: () => (list: unknown[]) => minMax(list, true),
  },
  {
    name: "max",
    signature: "max(list): dyn",
    category: "math",
    summary: "Largest element (by numeric value); null for an empty list.",
    deterministic: true,
    hostBacked: false,
    build: () => (list: unknown[]) => minMax(list, false),
  },
  {
    name: "sum",
    signature: "sum(list): double",
    category: "math",
    summary: "Sum of a list's numeric elements; 0 for an empty list.",
    deterministic: true,
    hostBacked: false,
    build: () => (list: unknown[]) =>
      Array.isArray(list) ? list.reduce((acc: number, x) => acc + num(x), 0) : 0,
  },
  {
    name: "avg",
    signature: "avg(list): dyn",
    category: "math",
    summary: "Arithmetic mean of a list's numeric elements; null for an empty list.",
    deterministic: true,
    hostBacked: false,
    build: () => (list: unknown[]) =>
      Array.isArray(list) && list.length > 0
        ? list.reduce((acc: number, x) => acc + num(x), 0) / list.length
        : null,
  },
  // JSON
  {
    name: "json",
    signature: "json(dyn): string",
    category: "json",
    summary: "Serialize any value to a JSON string.",
    deterministic: true,
    hostBacked: true,
    build: (h) => (value: unknown) => h.json(value),
  },
  {
    name: "parseJson",
    signature: "parseJson(string): dyn",
    category: "json",
    summary: "Parse a JSON string into a value (numbers come back as doubles).",
    deterministic: true,
    hostBacked: false,
    build: () => (s: string) => JSON.parse(s),
  },
  // Encoding
  {
    name: "base64Encode",
    signature: "base64Encode(string): string",
    category: "encoding",
    summary: "Encode a UTF-8 string as base64.",
    deterministic: true,
    hostBacked: true,
    build: (h) => (s: string) => h.base64Encode(s),
  },
  {
    name: "base64Decode",
    signature: "base64Decode(string): string",
    category: "encoding",
    summary: "Decode a base64 string to UTF-8.",
    deterministic: true,
    hostBacked: true,
    build: (h) => (s: string) => h.base64Decode(s),
  },
  // Base64 <-> BYTES, as distinct from the two above, which are UTF-8
  // string<->string and silently corrupt anything that is not text. Those keep
  // their meaning (changing it would change what shipped manifests mean); these
  // are the correct path for binary, and the pair a byte-typed slot needs.
  // Pure-JS on purpose: `Buffer` is what made the string pair host-backed, and
  // this package has to stay browser-safe.
  {
    name: "bytesFromBase64",
    signature: "bytesFromBase64(string): bytes",
    category: "encoding",
    summary: "Decode a base64 string to raw bytes.",
    deterministic: true,
    hostBacked: false,
    build: () => (s: string) => decodeBase64ToBytes(s),
  },
  {
    name: "bytesToBase64",
    signature: "bytesToBase64(bytes): string",
    category: "encoding",
    summary: "Encode raw bytes as a base64 string.",
    deterministic: true,
    hostBacked: false,
    build: () => (b: Uint8Array) => encodeBytesToBase64(b),
  },
  {
    name: "urlEncode",
    signature: "urlEncode(string): string",
    category: "encoding",
    summary: "Percent-encode a URI component.",
    deterministic: true,
    hostBacked: false,
    build: () => (s: string) => encodeURIComponent(s),
  },
  {
    name: "urlDecode",
    signature: "urlDecode(string): string",
    category: "encoding",
    summary: "Decode a percent-encoded URI component.",
    deterministic: true,
    hostBacked: false,
    build: () => (s: string) => decodeURIComponent(s),
  },
  // Hashing
  {
    name: "sha256",
    signature: "sha256(string): string",
    category: "hashing",
    summary: "SHA-256 hash, hex-encoded.",
    deterministic: true,
    hostBacked: true,
    build: (h) => (s: string) => h.sha256(s),
  },
  {
    name: "md5",
    signature: "md5(string): string",
    category: "hashing",
    summary: "MD5 hash, hex-encoded.",
    deterministic: true,
    hostBacked: true,
    build: (h) => (s: string) => h.md5(s),
  },
  {
    name: "sha1",
    signature: "sha1(string): string",
    category: "hashing",
    summary: "SHA-1 hash, hex-encoded.",
    deterministic: true,
    hostBacked: true,
    build: (h) => (s: string) => h.sha1(s),
  },
  {
    name: "sha512",
    signature: "sha512(string): string",
    category: "hashing",
    summary: "SHA-512 hash, hex-encoded.",
    deterministic: true,
    hostBacked: true,
    build: (h) => (s: string) => h.sha512(s),
  },
  {
    name: "hmac",
    signature: "hmac(string, string, string): string",
    category: "hashing",
    summary: "HMAC of message under key for an algorithm (e.g. 'sha256'), hex.",
    deterministic: true,
    hostBacked: true,
    build: (h) => (algo: string, key: string, msg: string) => h.hmac(algo, key, msg),
  },
  // Null handling
  {
    name: "default",
    signature: "default(dyn, dyn): dyn",
    category: "null",
    summary: "Return the value, or the fallback when it is null.",
    deterministic: true,
    hostBacked: false,
    build: () => (v: unknown, fallback: unknown) =>
      v === null || v === undefined ? fallback : v,
  },
  {
    name: "coalesce",
    signature: "coalesce(list): dyn",
    category: "null",
    summary: "First non-null element of a list, or null.",
    deterministic: true,
    hostBacked: false,
    build: () => (list: unknown[]) => {
      const found = list.find((x) => x !== null && x !== undefined);
      return found === undefined ? null : found;
    },
  },
  // Time (non-deterministic). `nowIso`/`today` take an optional IANA timezone
  // (default "UTC"); epoch values are absolute and take none.
  {
    name: "nowIso",
    signature: "nowIso(string?): string",
    category: "time",
    summary: "Current time as ISO-8601; UTC by default, or in the given IANA timezone.",
    deterministic: false,
    hostBacked: false,
    build: () => (tz?: string) => isoInZone(new Date(), tz ?? "UTC"),
  },
  {
    name: "today",
    signature: "today(string?): string",
    category: "time",
    summary: "Current calendar date (YYYY-MM-DD); UTC by default, or in the given IANA timezone.",
    deterministic: false,
    hostBacked: false,
    build: () => (tz?: string) => dateInZone(new Date(), tz ?? "UTC"),
  },
  {
    name: "nowMillis",
    signature: "nowMillis(): int",
    category: "time",
    summary: "Current time as epoch milliseconds (absolute; timezone-independent).",
    deterministic: false,
    hostBacked: false,
    build: () => () => BigInt(Date.now()),
  },
  {
    name: "nowSeconds",
    signature: "nowSeconds(): int",
    category: "time",
    summary: "Current time as epoch seconds (absolute; timezone-independent).",
    deterministic: false,
    hostBacked: false,
    build: () => () => BigInt(Math.floor(Date.now() / 1000)),
  },
  // Timestamp conversions. cel-go's standard library defines both and cel-js
  // ships neither, which is what made an instant a one-way door: timestamp
  // arithmetic and the `getFullYear` / `getHours` family already work, but
  // nothing converted the result back into a value a manifest field accepts,
  // so an expiry could be computed and not stored. Semantics follow cel-go
  // exactly — RFC 3339 and epoch SECONDS — so `int(timestamp)` and
  // `timestamp(int)` round-trip in one unit.
  {
    name: "string",
    signature: "string(timestamp): string",
    register: ["string(google.protobuf.Timestamp): string"],
    category: "conversion",
    summary: "Format an instant as RFC 3339 (ISO-8601, UTC).",
    deterministic: true,
    hostBacked: false,
    build: () => (t: Date) => t.toISOString(),
  },
  {
    name: "int",
    signature: "int(timestamp): int",
    register: ["int(google.protobuf.Timestamp): int"],
    category: "conversion",
    summary: "Epoch seconds of an instant (the unit `timestamp(int)` reads back).",
    deterministic: true,
    hostBacked: false,
    build: () => (t: Date) => BigInt(Math.floor(t.getTime() / 1000)),
  },
  // Formatting. The number surface is the d3-format specifier grammar in full,
  // `[[fill]align][sign][symbol][0][width][,][.precision][~][type]`, so a chart
  // axis label and the table cell beside it cannot round the same value two
  // ways. Rounding is therefore d3's: `f` rounds the double at the decimal
  // place, so `.2f` of 1.005 is "1.00" — 1.005 is not representable and the
  // nearest double sits below the half.
  {
    name: "format",
    signature: "format(dyn, string): string",
    // Registered per numeric type rather than as `dyn`. A `dyn` first parameter
    // accepted a string and answered "NaN" — a value that looks like an answer
    // and prints into a document. A genuinely dynamic expression still passes,
    // because cel-js matches `dyn` against any declared parameter type; what
    // this rejects is a STATICALLY known wrong type, at `telo check`.
    register: ["format(double, string): string", "format(int, string): string"],
    category: "formatting",
    summary: "Format a number with a d3-format specifier (`.2f`, `,.2f`, `.1%`, `.2s`).",
    deterministic: true,
    hostBacked: false,
    build: () => (x: unknown, spec: unknown) => formatter("format", spec)(formattable("format", x)),
    checkArgs: (lit) =>
      literalGuard(() => {
        if (lit[1] !== undefined) formatter("format", lit[1]);
        if (typeof lit[0] === "bigint") formattable("format", lit[0]);
      }),
  },
  {
    name: "fixed",
    signature: "fixed(dyn, int): string",
    register: ["fixed(double, int): string", "fixed(int, int): string"],
    category: "formatting",
    summary: "Fixed-decimal string with the given number of places (0–10).",
    deterministic: true,
    hostBacked: false,
    build: () => (x: unknown, digits: unknown) =>
      formatter("fixed", `.${digitCount("fixed", digits)}f`)(formattable("fixed", x)),
    checkArgs: (lit) =>
      literalGuard(() => {
        if (lit[1] !== undefined) digitCount("fixed", lit[1]);
        if (typeof lit[0] === "bigint") formattable("fixed", lit[0]);
      }),
  },
  {
    name: "formatDuration",
    signature: "formatDuration(dyn, int): string",
    register: [
      "formatDuration(double, int): string",
      "formatDuration(int, int): string",
    ],
    category: "formatting",
    summary:
      "Render a minute count against a declared day length: `formatDuration(510, 480)` is `1d 30m`. The day length is an argument because it is a policy, not arithmetic. The result is a rendering for a reader, not a duration literal — its `d` is the declared day, so it must not be fed back into a field that parses a duration.",
    deterministic: true,
    hostBacked: false,
    build: () => (minutes: unknown, minutesPerDay: unknown) => durationText(minutes, minutesPerDay),
    checkArgs: (lit) =>
      literalGuard(() => {
        if (lit[1] !== undefined) durationText(lit[0] ?? 0, lit[1]);
      }),
  },
  {
    name: "dateIn",
    signature: "dateIn(timestamp, string?): string",
    register: [
      "dateIn(google.protobuf.Timestamp): string",
      "dateIn(google.protobuf.Timestamp, string): string",
    ],
    category: "time",
    summary: "Calendar date (`YYYY-MM-DD`) of an instant, in an IANA zone (UTC by default).",
    deterministic: true,
    hostBacked: false,
    build: () => (t: unknown, tz?: string) => dateInZone(instantArg("dateIn", t), assertZone("dateIn", tz ?? "UTC")),
    checkArgs: (lit) =>
      literalGuard(() => {
        if (typeof lit[1] === "string") assertZone("dateIn", lit[1]);
      }),
  },
  {
    name: "isoIn",
    signature: "isoIn(timestamp, string?): string",
    register: [
      "isoIn(google.protobuf.Timestamp): string",
      "isoIn(google.protobuf.Timestamp, string): string",
    ],
    category: "time",
    summary: "ISO-8601 rendering of an instant, in an IANA zone (UTC by default).",
    deterministic: true,
    hostBacked: false,
    build: () => (t: unknown, tz?: string) => isoInZone(instantArg("isoIn", t), assertZone("isoIn", tz ?? "UTC")),
    checkArgs: (lit) =>
      literalGuard(() => {
        if (typeof lit[1] === "string") assertZone("isoIn", lit[1]);
      }),
  },
  {
    name: "startOfMonth",
    signature: "startOfMonth(timestamp, string?): timestamp",
    register: [
      "startOfMonth(google.protobuf.Timestamp): google.protobuf.Timestamp",
      "startOfMonth(google.protobuf.Timestamp, string): google.protobuf.Timestamp",
    ],
    category: "time",
    summary: "Midnight on the 1st of the instant's month, in an IANA zone (UTC by default).",
    deterministic: true,
    hostBacked: false,
    checkArgs: (lit) =>
      literalGuard(() => {
        if (typeof lit[1] === "string") assertZone("startOfMonth", lit[1]);
      }),
    build: () => (t: unknown, tz?: string) => {
      const zone = assertZone("startOfMonth", tz ?? "UTC");
      const f = zonedFields(instantArg("startOfMonth", t), zone);
      return instantOfZoned(
        { year: f.year, month: f.month, day: 1, hour: 0, minute: 0, second: 0 },
        zone,
      );
    },
  },
  {
    name: "addMonths",
    signature: "addMonths(timestamp, int, string?): timestamp",
    register: [
      "addMonths(google.protobuf.Timestamp, int): google.protobuf.Timestamp",
      "addMonths(google.protobuf.Timestamp, int, string): google.protobuf.Timestamp",
    ],
    category: "time",
    summary:
      "Shift an instant by whole months in an IANA zone, clamping the day of month (Jan 31 + 1 month is Feb 28).",
    deterministic: true,
    hostBacked: false,
    checkArgs: (lit) =>
      literalGuard(() => {
        if (typeof lit[2] === "string") assertZone("addMonths", lit[2]);
      }),
    build: () => (t: unknown, months: unknown, tz?: string) => {
      const zone = assertZone("addMonths", tz ?? "UTC");
      const f = zonedFields(instantArg("addMonths", t), zone);
      const shifted = f.year * 12 + (f.month - 1) + Number(months);
      // `%` takes the dividend's sign in JS, so a negative total would yield
      // month 0. Unreachable for realistic dates and wrong for free otherwise.
      const year = Math.floor(shifted / 12);
      const month = (((shifted % 12) + 12) % 12) + 1;
      return instantOfZoned({ ...f, year, month, day: Math.min(f.day, daysInMonth(year, month)) }, zone);
    },
  },
  {
    name: "compact",
    signature: "compact(dyn): dyn",
    // A `dyn` parameter accepted an instant (yielding `{}`) and a byte buffer
    // (yielding `{"0":137,…}`), both silently and both passing `telo check`.
    register: ["compact(list): list", "compact(map): map"],
    category: "collection",
    summary: "Drop entries whose value is null or the empty string, from a map or a list.",
    deterministic: true,
    hostBacked: false,
    build: () => (v: unknown) => compactValue(v),
  },
  {
    name: "merge",
    signature: "merge(map, map): map",
    register: ["merge(map, map): map"],
    category: "collection",
    summary:
      "Combine two maps, with the right-hand map winning on a shared key. Use it to add to a map rather than replace it — `merge(defaults, overrides)`.",
    deterministic: true,
    hostBacked: false,
    build: () => (a: unknown, b: unknown) => mergeMaps(a, b),
  },
  // UUID
  {
    name: "uuidv1",
    signature: "uuidv1(): string",
    category: "uuid",
    summary: "Time-based UUID (v1).",
    deterministic: false,
    hostBacked: false,
    build: () => () => v1(),
  },
  {
    name: "uuidv4",
    signature: "uuidv4(): string",
    category: "uuid",
    summary: "Random UUID (v4).",
    deterministic: false,
    hostBacked: false,
    build: () => () => v4(),
  },
  {
    name: "uuidv6",
    signature: "uuidv6(): string",
    category: "uuid",
    summary: "Time-ordered UUID (v6).",
    deterministic: false,
    hostBacked: false,
    build: () => () => v6(),
  },
  {
    name: "uuidv7",
    signature: "uuidv7(): string",
    category: "uuid",
    summary: "Time-ordered UUID (v7).",
    deterministic: false,
    hostBacked: false,
    build: () => () => v7(),
  },
  {
    name: "uuidv3",
    signature: "uuidv3(string, string): string",
    category: "uuid",
    summary: "Name-based UUID (v3, MD5) under a namespace UUID.",
    deterministic: true,
    hostBacked: false,
    build: () => (name: string, ns: string) => v3(name, ns),
  },
  {
    name: "uuidv5",
    signature: "uuidv5(string, string): string",
    category: "uuid",
    summary: "Name-based UUID (v5, SHA-1) under a namespace UUID.",
    deterministic: true,
    hostBacked: false,
    build: () => (name: string, ns: string) => v5(name, ns),
  },
  {
    name: "uuidValidate",
    signature: "uuidValidate(string): bool",
    category: "uuid",
    summary: "True if the string is a valid UUID.",
    deterministic: true,
    hostBacked: false,
    build: () => (s: string) => uuidValidate(s),
  },
  {
    name: "uuidVersion",
    signature: "uuidVersion(string): int",
    category: "uuid",
    summary: "The version number of a UUID.",
    deterministic: true,
    hostBacked: false,
    build: () => (s: string) => BigInt(uuidVersion(s)),
  },
];

/** Build-free catalog for the CLI / docs (`telo cel functions`). */
export function celFunctionCatalog(): CelFunctionInfo[] {
  return CEL_FUNCTIONS.map(({ build: _build, ...info }) => info);
}
