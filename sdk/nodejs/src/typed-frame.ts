/**
 * The typed frame — `kernel/specs/durable-execution.md` §6.1–§6.6.
 *
 * One schema-independent JSON form over the whole CEL value domain, for a
 * boundary whose reader turns a value back into a live value inside a Telo
 * runtime. It is one-to-one: a value's CEL type survives the trip, two different
 * values never share a frame, and the text is canonical (RFC 8785 plus a pair
 * order for tagged maps), so two runtimes writing one value write the same bytes.
 * A tagged payload is the type's plain encoding ({@link PLAIN_ENCODINGS}), so a
 * type still has exactly one encoding.
 *
 * It refuses rather than approximates, in both directions. A value outside the
 * domain would come back as something else — a class instance relying on
 * `toJSON` returns as a plain object — and a payload outside its canonical form
 * means a writer that disagrees with this one, or a reader that would silently
 * round it.
 */
import {
  celMapFromEntries,
  celUint,
  isCelDuration,
  isCelMap,
  isCelTimestamp,
  isCelUint,
  type CelDuration,
  type CelTimestamp,
  type CelValue,
} from "./cel-value-identity.js";
import { InvokeError } from "./invoke-error.js";
import {
  MAX_DURATION_SECONDS,
  NANOS_PER_SECOND,
  requirePlainEncoding,
  type PlainEncoding,
} from "./plain-encoding.js";

/** The key marking a tagged value. A map holding it as a key is itself tagged. */
export const TYPED_FRAME_TAG = "$telo";

/** The closed tag vocabulary. A frame carrying any other tag is refused. */
export const TYPED_FRAME_TAGS = [
  "int",
  "uint",
  "double",
  "bytes",
  "google.protobuf.Timestamp",
  "google.protobuf.Duration",
  "map",
] as const;

export type TypedFrameTag = (typeof TYPED_FRAME_TAGS)[number];

const UNENCODABLE = "ERR_TYPED_FRAME_UNENCODABLE";
const UNDECODABLE = "ERR_TYPED_FRAME_UNDECODABLE";

const bytesEncoding = requirePlainEncoding("base64url", "The typed frame");
const timestampEncoding = requirePlainEncoding("rfc3339", "The typed frame");
const durationEncoding = requirePlainEncoding("cel-duration", "The typed frame");

const MILLIS_RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * The timestamp payload **generation 1** wrote: UTC with exactly three fractional
 * digits, the finest instant that generation's writer could hold.
 *
 * Read, never written. A value already recorded under generation 1 is read with the
 * grammar of the writer that made it, rather than refused for not being the form this
 * runtime writes — the frame's canonical-only rule is about two writers disagreeing,
 * and a generation says which writer it was.
 */
const generationOneTimestamp: PlainEncoding = {
  form: "RFC 3339 text with exactly three fractional digits (2026-01-15T09:30:00.000Z)",
  schema: { type: "string", format: "date-time" },
  decode(text) {
    return MILLIS_RFC3339.test(text) ? timestampEncoding.decode(text) : undefined;
  },
  encode(value) {
    if (!isCelTimestamp(value)) throw new TypeError("a generation 1 timestamp payload encodes a timestamp");
    const whole = timestampEncoding.encode({ ...value, nanos: 0 });
    return `${whole.slice(0, -1)}.${String(Math.floor(value.nanos / 1_000_000)).padStart(3, "0")}Z`;
  },
};

/** The generation this runtime WRITES, and the one a reader assumes when none is named. */
export const TYPED_FRAME_GENERATION = 2;

/** Every generation this runtime reads. A generation differs only in a tagged scalar's
 *  payload text, so it is one table rather than a second reader. */
const GENERATION_PAYLOADS: Readonly<Record<number, PlainEncoding>> = {
  1: generationOneTimestamp,
  2: timestampEncoding,
};

/** True when this runtime can read a frame written by `generation`. */
export function readsTypedFrameGeneration(generation: number): boolean {
  return generation in GENERATION_PAYLOADS;
}

/** The generations this runtime reads, ascending — what a refusal names. */
export function typedFrameGenerations(): number[] {
  return Object.keys(GENERATION_PAYLOADS).map(Number);
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;

const INT_TEXT = /^(?:0|-?[1-9][0-9]*)$/;
const UINT_TEXT = /^(?:0|[1-9][0-9]*)$/;
const LONE_SURROGATE = /\p{Cs}/u;
const LONE_SURROGATES = /\p{Cs}/gu;

/** The doubles a JSON number cannot carry faithfully: JSON has no NaN or
 *  infinity, and a negative zero does not survive common JSON stores. */
const TAGGED_DOUBLES: ReadonlyMap<string, number> = new Map([
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["-Infinity", Number.NEGATIVE_INFINITY],
  ["-0", -0],
]);

/**
 * The canonical frame text of a CEL value.
 *
 * Throws `ERR_TYPED_FRAME_UNENCODABLE`, with `data.path` the JSON Pointer of the
 * offending node inside the value, for anything outside the CEL value domain.
 */
export function encodeTypedFrame(value: unknown): string {
  return writeValue(value, [], new Set());
}

/**
 * The value a frame encodes. Accepts any JSON syntax for the frame's structure
 * (whitespace, key order); a tagged payload must be in its canonical form — for the
 * `generation` that wrote it, which defaults to the one this runtime writes.
 *
 * Throws `ERR_TYPED_FRAME_UNDECODABLE`, with `data.path` the JSON Pointer of the
 * offending node inside the frame.
 */
export function decodeTypedFrame(text: string, generation: number = TYPED_FRAME_GENERATION): unknown {
  const timestamps = GENERATION_PAYLOADS[generation];
  if (!timestamps) {
    throw new Error(`A typed frame of generation ${generation} is not one this runtime reads.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new InvokeError(
      UNDECODABLE,
      `A typed frame is not valid JSON: ${(err as Error).message}`,
      { path: "" },
      { cause: err },
    );
  }
  const repeated = repeatedMember(text);
  if (repeated) {
    throw undecodable(repeated, "repeats a member name of its object, which no writer produces");
  }
  return readValue(parsed, [], timestamps);
}

/** A key as a path segment: an unpaired surrogate becomes U+FFFD, so a pointer is
 *  always Unicode text and names the key as every runtime renders it. */
function keySegment(key: string): string {
  return key.replace(LONE_SURROGATES, "�");
}

/**
 * The path of the first object member, in text order, whose name an earlier
 * member of the same object already carries — or undefined. `JSON.parse` keeps
 * the last and says nothing, so the valid JSON `text` is walked for it.
 */
function repeatedMember(text: string): string[] | undefined {
  let at = 0;
  const path: string[] = [];
  const space = () => {
    while (text[at] === " " || text[at] === "\t" || text[at] === "\n" || text[at] === "\r") at++;
  };
  const string = (): string => {
    const start = at++;
    while (text[at] !== '"') at += text[at] === "\\" ? 2 : 1;
    return JSON.parse(text.slice(start, ++at)) as string;
  };
  const value = (): string[] | undefined => {
    space();
    if (text[at] === '"') {
      string();
      return undefined;
    }
    if (text[at] === "[" || text[at] === "{") {
      const object = text[at++] === "{";
      const close = object ? "}" : "]";
      const seen = new Set<string>();
      space();
      if (text[at] === close) {
        at++;
        return undefined;
      }
      for (let index = 0; ; index++) {
        if (object) {
          space();
          const key = string();
          path.push(keySegment(key));
          if (seen.has(key)) return path;
          seen.add(key);
          space();
          at++;
        } else {
          path.push(String(index));
        }
        const found = value();
        if (found) return found;
        path.pop();
        space();
        if (text[at++] === close) return undefined;
      }
    }
    while (at < text.length && !",]} \t\n\r".includes(text[at]!)) at++;
    return undefined;
  };
  return value();
}

function pointer(path: readonly string[]): string {
  return path.map((segment) => `/${segment.replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

function where(path: readonly string[]): string {
  return path.length === 0 ? "the value itself" : `the value at '${pointer(path)}'`;
}

function unencodable(path: readonly string[], detail: string): InvokeError {
  return new InvokeError(
    UNENCODABLE,
    `Cannot write a typed frame: ${where(path)} ${detail}.`,
    { path: pointer(path) },
  );
}

function undecodable(path: readonly string[], detail: string): InvokeError {
  const at = path.length === 0 ? "the frame" : `'${pointer(path)}'`;
  return new InvokeError(UNDECODABLE, `Cannot read a typed frame: ${at} ${detail}.`, {
    path: pointer(path),
  });
}

function tagged(tag: TypedFrameTag, payload: string): string {
  return `{"${TYPED_FRAME_TAG}":"${tag}","value":${payload}}`;
}

function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "function") return "a function";
  if (typeof value === "symbol") return "a symbol";
  const prototype = Object.getPrototypeOf(value);
  const name = prototype?.constructor?.name;
  const instance = name ? `an instance of ${name}` : "an object with a foreign prototype";
  return typeof (value as { toJSON?: unknown }).toJSON === "function"
    ? `${instance} (its toJSON() is not read: what it returns would decode as a different value)`
    : instance;
}

// ---------------------------------------------------------------------------
// Writing

function writeValue(value: unknown, path: string[], open: Set<object>): string {
  switch (typeof value) {
    case "string":
      return writeString(value, path);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (Number.isFinite(value) && !Object.is(value, -0)) return JSON.stringify(value);
      return tagged("double", JSON.stringify(taggedDoubleText(value)));
    case "bigint":
      return writeInt(value, path);
    case "object":
      return value === null ? "null" : writeObject(value, path, open);
    default:
      throw unencodable(path, `is ${describe(value)}, which is not a CEL value`);
  }
}

function taggedDoubleText(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "Infinity";
  if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
  return "-0";
}

function writeString(value: string, path: readonly string[]): string {
  if (LONE_SURROGATE.test(value)) {
    throw unencodable(path, "is a string holding an unpaired UTF-16 surrogate, which is not Unicode text");
  }
  return JSON.stringify(value);
}

function writeInt(value: bigint, path: readonly string[]): string {
  if (value < INT64_MIN || value > INT64_MAX) {
    throw unencodable(path, `is the integer ${value}, outside CEL's int64 range`);
  }
  return tagged("int", `"${value}"`);
}

function writeObject(value: object, path: string[], open: Set<object>): string {
  if (isCelUint(value)) return tagged("uint", `"${value.value}"`);
  if (value instanceof Uint8Array) return tagged("bytes", `"${bytesEncoding.encode(value)}"`);
  if (isCelTimestamp(value)) return writeTimestamp(value, path);
  if (isCelDuration(value)) return writeDuration(value, path);
  // A `Date` is a FOREIGN HOST OBJECT, never a Telo value: an instant is seconds plus
  // nanoseconds, which no host date type holds. Named here rather than left to the
  // prototype refusal below, because the author needs the factory, not the diagnosis.
  if (value instanceof Date) {
    throw unencodable(
      path,
      "is a Date, a host object outside the CEL value domain — build an instant with " +
        "celTimestamp(seconds, nanos) or celTimestampFromMillis(ms)",
    );
  }

  // A map is the value domain's own container, which carries the type key `map` and holds
  // its entries by each key's typed value — so it is read here, ABOVE the symbol refusal
  // that its own key would otherwise trip. A host `Map` is not one and falls through to
  // the prototype refusal below, by name: under the engine this replaced a `Map` with
  // `bigint` keys WAS a CEL map with int keys, so a controller still building one has to
  // be told rather than have its value silently flattened to text keys.
  if (isCelMap(value)) {
    if (open.has(value)) throw unencodable(path, "refers back to a value containing it");
    open.add(value);
    try {
      const entries = [...value.entries.values()].map(
        (entry) => [entry.key, entry.value] as [unknown, unknown],
      );
      return writeMapEntries(entries, path, open);
    } finally {
      open.delete(value);
    }
  }

  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!isArray && prototype !== Object.prototype && prototype !== null) {
    throw unencodable(path, `is ${describe(value)}, which is not a CEL value`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw unencodable(path, "carries a symbol-keyed property, which no CEL value holds");
  }
  if (open.has(value)) throw unencodable(path, "refers back to a value containing it");
  open.add(value);
  try {
    if (isArray) return writeList(value as unknown[], path, open);
    return writeMapEntries(Object.entries(value), path, open);
  } finally {
    open.delete(value);
  }
}

function writeTimestamp(value: CelTimestamp, path: readonly string[]): string {
  if (!Number.isInteger(value.nanos) || value.nanos < 0 || value.nanos >= 1_000_000_000) {
    throw unencodable(path, `is an instant whose nanos (${value.nanos}) is not in [0, 1000000000)`);
  }
  const text = timestampEncoding.encode(value);
  if (timestampEncoding.decode(text) === undefined) {
    throw unencodable(path, `is the instant ${text}, outside CEL's timestamp range`);
  }
  return tagged("google.protobuf.Timestamp", `"${text}"`);
}

function writeDuration(value: CelDuration, path: readonly string[]): string {
  if (!Number.isSafeInteger(value.nanos)) {
    throw unencodable(path, `is a duration whose nanos (${value.nanos}) is not an integer`);
  }
  const total = value.seconds * NANOS_PER_SECOND + BigInt(value.nanos);
  const magnitude = total < 0n ? -total : total;
  if (magnitude / NANOS_PER_SECOND > MAX_DURATION_SECONDS) {
    throw unencodable(path, `is a duration outside protobuf's range of ±${MAX_DURATION_SECONDS}s`);
  }
  return tagged("google.protobuf.Duration", `"${durationEncoding.encode(value)}"`);
}

function writeList(items: unknown[], path: string[], open: Set<object>): string {
  const parts: string[] = [];
  // A property beside the items is data a CEL list cannot hold, so it is refused
  // rather than dropped — dropping it would write a frame for another value.
  for (const key of Object.keys(items)) {
    const index = Number(key);
    if (Number.isInteger(index) && index >= 0 && index < items.length && String(index) === key) continue;
    throw unencodable([...path, key], "is a property beside a list's items, which a CEL list cannot hold");
  }
  for (let index = 0; index < items.length; index++) {
    path.push(String(index));
    if (!(index in items)) throw unencodable(path, "is a hole in a sparse array");
    if (items[index] === undefined) throw unencodable(path, "is undefined, which is not a CEL value");
    parts.push(writeValue(items[index], path, open));
    path.pop();
  }
  return `[${parts.join(",")}]`;
}

/** A map with only string keys, none of them the tag key, is a plain object;
 *  any other map is a tagged list of pairs ordered by key text. */
function writeMapEntries(entries: [unknown, unknown][], path: string[], open: Set<object>): string {
  const pairs: { order: string; key: string; value: string }[] = [];
  const seen = new Set<string | bigint | boolean>();
  let plain = true;
  for (const [key, entryValue] of entries) {
    const keyText = writeMapKey(key, path);
    const identity = mapKeyIdentity(key)!;
    if (seen.has(identity)) throw unencodable(path, `is a map with two keys equal to ${keyText}`);
    seen.add(identity);
    if (typeof key !== "string" || key === TYPED_FRAME_TAG) plain = false;
    path.push(String(key));
    if (entryValue === undefined) throw unencodable(path, "is undefined, which is not a CEL value");
    const order = typeof key === "string" ? key : keyText;
    pairs.push({ order, key: keyText, value: writeValue(entryValue, path, open) });
    path.pop();
  }
  if (plain) {
    // RFC 8785: members ordered by the key's own code units.
    pairs.sort((a, b) => compareCodeUnits(a.order, b.order));
    return `{${pairs.map((pair) => `${pair.key}:${pair.value}`).join(",")}}`;
  }
  // Pairs ordered by the key's frame text, so every key type shares one order.
  pairs.sort((a, b) => compareCodeUnits(a.key, b.key));
  return tagged("map", `[${pairs.map((pair) => `[${pair.key},${pair.value}]`).join(",")}]`);
}

function writeMapKey(key: unknown, path: readonly string[]): string {
  if (typeof key === "string") return writeString(key, path);
  if (typeof key === "boolean") return key ? "true" : "false";
  if (typeof key === "bigint") return writeInt(key, path);
  if (isCelUint(key)) return tagged("uint", `"${key.value}"`);
  const shown = typeof key === "number" ? `the number ${key}` : describe(key);
  throw unencodable(path, `is a map with a key that is ${shown}; a CEL map key is an int, uint, bool or string`);
}

/** UTF-16 code unit order, RFC 8785's property order. */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Reading

function readValue(node: unknown, path: string[], timestamps: PlainEncoding): unknown {
  if (typeof node === "number" && !Number.isFinite(node)) {
    throw undecodable(path, "is a number beyond the range of a double; a non-finite double is tagged 'double'");
  }
  if (node === null || typeof node === "boolean" || typeof node === "number") return node;
  if (typeof node === "string") return readString(node, path);
  if (Array.isArray(node)) {
    return node.map((item, index) => {
      path.push(String(index));
      const value = readValue(item, path, timestamps);
      path.pop();
      return value;
    });
  }
  const record = node as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, TYPED_FRAME_TAG)) return readTagged(record, path, timestamps);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    path.push(keySegment(key));
    defineEntry(out, readString(key, path), readValue(record[key], path, timestamps));
    path.pop();
  }
  return out;
}

/** `__proto__` is an ordinary key in a frame, never a prototype assignment. */
function defineEntry(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function readString(text: string, path: readonly string[]): string {
  if (LONE_SURROGATE.test(text)) throw undecodable(path, "holds an unpaired UTF-16 surrogate");
  return text;
}

function readTagged(record: Record<string, unknown>, path: string[], timestamps: PlainEncoding): unknown {
  const keys = Object.keys(record);
  const tag = record[TYPED_FRAME_TAG];
  if (keys.length !== 2 || !keys.includes("value") || typeof tag !== "string") {
    throw undecodable(path, `is a tagged value, which carries exactly a string '${TYPED_FRAME_TAG}' and a 'value'`);
  }
  if (!(TYPED_FRAME_TAGS as readonly string[]).includes(tag)) {
    throw undecodable(
      [...path, TYPED_FRAME_TAG],
      `names the tag '${tag}', which is not one of ${TYPED_FRAME_TAGS.join(", ")}`,
    );
  }
  const payload = record.value;
  path.push("value");
  let value: unknown;
  if (tag === "map") {
    value = readMap(payload, path, timestamps);
  } else if (typeof payload !== "string") {
    throw undecodable(path, `is not a string, and a '${tag}' payload is text`);
  } else {
    value = readScalar(tag as Exclude<TypedFrameTag, "map">, payload, path, timestamps);
  }
  path.pop();
  return value;
}

function readScalar(
  tag: Exclude<TypedFrameTag, "map">,
  text: string,
  path: readonly string[],
  timestamps: PlainEncoding,
): unknown {
  switch (tag) {
    case "int": {
      const value = INT_TEXT.test(text) ? BigInt(text) : undefined;
      if (value === undefined || value < INT64_MIN || value > INT64_MAX) {
        throw undecodable(path, `is '${text}', not a canonical int64 decimal`);
      }
      return value;
    }
    case "uint": {
      const value = UINT_TEXT.test(text) ? BigInt(text) : undefined;
      if (value === undefined || value > UINT64_MAX) {
        throw undecodable(path, `is '${text}', not a canonical uint64 decimal`);
      }
      return celUint(value);
    }
    case "double": {
      const value = TAGGED_DOUBLES.get(text);
      if (value === undefined) {
        throw undecodable(path, `is '${text}'; a tagged double is one of ${[...TAGGED_DOUBLES.keys()].join(", ")}`);
      }
      return value;
    }
    case "bytes":
      return readCanonical(bytesEncoding, text, path);
    case "google.protobuf.Timestamp":
      return readCanonical(timestamps, text, path);
    case "google.protobuf.Duration":
      return readCanonical(durationEncoding, text, path);
  }
}

/** A payload is read only in the form this runtime writes, so a reader never
 *  silently rounds or reinterprets what another writer produced. */
function readCanonical(encoding: PlainEncoding, text: string, path: readonly string[]): unknown {
  const value = encoding.decode(text);
  if (value === undefined || encoding.encode(value) !== text) {
    throw undecodable(path, `is '${text}', not ${encoding.form} in its canonical written form`);
  }
  return value;
}

/**
 * A tagged map read back as the value domain's own container. The refusals below are the
 * FRAME's wire contract — each naming the path it was found at — so they are decided here
 * and the engine's builder only ever sees entries that have already passed them; a refusal
 * it could still raise is this reader disagreeing with itself.
 */
function readMap(payload: unknown, path: string[], timestamps: PlainEncoding): unknown {
  if (!Array.isArray(payload)) throw undecodable(path, "is not a list of key/value pairs");
  const flat: CelValue[] = [];
  const seen = new Set<string | bigint | boolean>();
  let plain = true;
  payload.forEach((pair, index) => {
    path.push(String(index));
    if (!Array.isArray(pair) || pair.length !== 2) throw undecodable(path, "is not a [key, value] pair");
    path.push("0");
    const key = readValue(pair[0], path, timestamps);
    const identity = mapKeyIdentity(key);
    if (identity === undefined) throw undecodable(path, "is not an int, uint, bool or string map key");
    if (seen.has(identity)) throw undecodable(path, "repeats a key already in the map");
    seen.add(identity);
    if (typeof key !== "string" || key === TYPED_FRAME_TAG) plain = false;
    path[path.length - 1] = "1";
    flat.push(key as CelValue, readValue(pair[1], path, timestamps) as CelValue);
    path.pop();
    path.pop();
  });
  if (plain) {
    throw undecodable(path, `is a map whose keys are all strings other than '${TYPED_FRAME_TAG}', which is written untagged`);
  }
  const map = celMapFromEntries(flat);
  if (!isCelMap(map)) {
    throw undecodable(path, "is a map the value domain refuses, which this reader should have refused first");
  }
  return map;
}

/**
 * What makes two keys ONE key. An `int` and a `uint` of the same number compare
 * equal in CEL, so a map carrying both is not a map — it is refused at both ends
 * rather than written as two entries a reader would have to reconcile.
 *
 * **This is the same rule the engine keys a `CelMap`'s entries by, stated a
 * second time, and that is deliberate.** The engine does not export it: what
 * identifies an entry is its entries map's own business, and publishing it is how
 * this copy came to exist in the first place. What the frame needs is not the
 * engine's map but a dedup key for a Set, under refusals that are the FRAME's
 * wire contract — each naming the path it was found at and the key it repeats —
 * which the engine's `duplicate_map_key` would replace with its own wording.
 *
 * So the duplication is kept and made checkable instead of silent:
 * `tests/typed-frame-map-key.test.ts` holds the two to one answer over a key set
 * built to attack the question (`"1"` against `1`, `"true"` against `true`, a
 * uint against an int, a double that is whole and one that is not).
 */
function mapKeyIdentity(key: unknown): string | bigint | boolean | undefined {
  const held = typeof key;
  if (held === "string" || held === "boolean" || held === "bigint") return key as string | boolean | bigint;
  return isCelUint(key) ? key.value : undefined;
}
