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
}

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

/** Ensure a regex replaces every match: append the global flag unless the
 *  caller already passed it. */
const withGlobal = (flags?: string): string =>
  flags && flags.includes("g") ? flags : `${flags ?? ""}g`;

const sortList = (list: unknown[]): unknown[] =>
  [...list].sort((a, b) => {
    if (typeof a === "number" || typeof a === "bigint") {
      const d = num(a) - num(b);
      return d < 0 ? -1 : d > 0 ? 1 : 0;
    }
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  });

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
const isoInZone = (tz: string): string => {
  const now = new Date();
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

/** Current calendar date (`YYYY-MM-DD`) in `tz`. */
const dateInZone = (tz: string): string => {
  const now = new Date();
  if (tz === "UTC" || tz === "Z") return now.toISOString().slice(0, 10);
  const p = zoneParts(now, tz, { year: "numeric", month: "2-digit", day: "2-digit" });
  return `${p.year}-${p.month}-${p.day}`;
};

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
    summary: "Replace every regex match with a replacement ($1 backrefs); flags like 'i', 'm', 's'.",
    deterministic: true,
    hostBacked: false,
    build: () => (s: string, pattern: string, replacement: string, flags?: string) =>
      s.replace(new RegExp(pattern, withGlobal(flags)), replacement),
  },
  {
    name: "regexExtract",
    signature: "regexExtract(string, string): string",
    category: "string",
    summary: "First whole match of a regex, or '' when there is none.",
    deterministic: true,
    hostBacked: false,
    build: () => (s: string, pattern: string) => s.match(new RegExp(pattern))?.[0] ?? "",
  },
  {
    name: "regexExtractAll",
    signature: "regexExtractAll(string, string): list<string>",
    category: "string",
    summary: "Every whole match of a regex, in order.",
    deterministic: true,
    hostBacked: false,
    build: () => (s: string, pattern: string) =>
      [...s.matchAll(new RegExp(pattern, "g"))].map((m) => m[0]),
  },
  {
    name: "regexGroups",
    signature: "regexGroups(string, string): list<string>",
    category: "string",
    summary: "Capture groups of the first regex match (empty list when there is no match).",
    deterministic: true,
    hostBacked: false,
    build: () => (s: string, pattern: string) => {
      const m = s.match(new RegExp(pattern));
      return m ? m.slice(1).map((g) => g ?? "") : [];
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
    signature: "round(dyn): double",
    category: "math",
    summary: "Round to the nearest integer.",
    deterministic: true,
    hostBacked: false,
    build: () => (x: unknown) => Math.round(num(x)),
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
    build: () => (tz?: string) => isoInZone(tz ?? "UTC"),
  },
  {
    name: "today",
    signature: "today(string?): string",
    category: "time",
    summary: "Current calendar date (YYYY-MM-DD); UTC by default, or in the given IANA timezone.",
    deterministic: false,
    hostBacked: false,
    build: () => (tz?: string) => dateInZone(tz ?? "UTC"),
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
