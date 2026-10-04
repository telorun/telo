/**
 * The conformance value (`templating/cel-conformance/README.md`): the typed frame
 * held as a JSON value, plus the `$cel` forms for a type and an optional.
 *
 * **The typed frame is still the writer**, which is the format's own rule — a row pins
 * exactly what a host is handed, in the encoding every Telo boundary uses. What the engine
 * swap changed is one representation: the CEL value domain's instant is a branded value
 * carrying seconds and nanos, while the typed frame writes one from a `Date`. The encoding
 * carries milliseconds and nothing finer, so the two are bridged here — an instant finer
 * than a millisecond is refused rather than rounded, which is what the frame's own range
 * refusals already do.
 */
import {
  celMapFromEntries,
  celNone,
  celSome,
  celTimestamp,
  celTypeValue,
  formatTimestamp,
  isCelDuration,
  isCelError,
  isCelMap,
  isCelOptional,
  isCelRecord,
  isCelTimestamp,
  isCelTypeValue,
  isCelUint,
  timestampNanos,
  type CelMapKey,
  type CelValue,
} from "@telorun/cel";
import { decodeTypedFrame, encodeTypedFrame, TYPED_FRAME_TAG } from "@telorun/sdk";

export type ConformanceValue =
  | null
  | boolean
  | number
  | string
  | ConformanceValue[]
  | { [key: string]: ConformanceValue };

export interface ConformanceValueCodec {
  /** Refuses a value that does not decode back to the same encoding. */
  encode(value: unknown): ConformanceValue;
  /** Refuses a node that is not the canonical encoding of what it decodes to. */
  decode(node: ConformanceValue): unknown;
}

const CEL_TAG = "$cel";
const NANOS_PER_MILLISECOND = 1_000_000;

const UNPAIRED_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Where a parsed conformance file holds a string — a value or a key — with an
 *  unpaired surrogate, as a JSON pointer; undefined when it holds none. Such a
 *  string is outside the CEL value domain, so the file is malformed. */
export function unpairedSurrogateAt(document: unknown, path = ""): string | undefined {
  if (typeof document === "string") return UNPAIRED_SURROGATE.test(document) ? path : undefined;
  if (document === null || typeof document !== "object") return undefined;
  for (const [key, entry] of Object.entries(document)) {
    const at = `${path}/${key}`;
    if (UNPAIRED_SURROGATE.test(key)) return at;
    const found = unpairedSurrogateAt(entry, at);
    if (found !== undefined) return found;
  }
  return undefined;
}

function refuse(path: readonly string[], detail: string): Error {
  return new Error(`Cannot write a conformance value: '/${path.join("/")}' ${detail}.`);
}

function unreadable(path: readonly string[], detail: string): Error {
  return new Error(`Cannot read a conformance value: '/${path.join("/")}' ${detail}.`);
}

/** How a type value is spelled in the vectors, which is not how the engine names it. */
const recordedTypeName = (name: string) => (name === "null_type" ? "null" : name);
const engineTypeName = (recorded: string) => (recorded === "null" ? "null_type" : recorded);

/**
 * What the typed frame is handed is the CEL value itself.
 *
 * This used to convert on the way in — an instant to a `Date`, a map to a host `Map` — because
 * the frame took those. It takes the value domain now and REFUSES both by name (a `Date` is
 * "a host object outside the CEL value domain"; a host `Map` with `bigint` keys was a CEL map
 * under the engine that was replaced, so a producer still building one is told rather than
 * having its keys flattened to text). It also carries nanoseconds, so the millisecond-precision
 * guard this function used to apply refused instants the frame can now write.
 *
 * Kept as a named step rather than inlined: a row hands a value to the frame, and that is the
 * one place to say what crosses.
 */
function forFrame(value: unknown): unknown {
  return value;
}

/** A value as the typed frame writes it — the text a handler row pins. */
export function typedFrameText(value: unknown): string {
  return encodeTypedFrame(forFrame(value));
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** What makes two keys ONE key, as CEL equality does: an int and a uint of the same
 *  number are one. The engine keys its own entries this way and deliberately exports no
 *  rule for it, so a reader derives its own — which is what a port does too. */
function mapKeyIdentity(key: unknown): string | undefined {
  if (typeof key === "string") return `s${key}`;
  if (typeof key === "boolean") return `b${key}`;
  if (typeof key === "bigint") return `n${key}`;
  if (isCelUint(key)) return `n${key.value}`;
  return undefined;
}

export function conformanceValueCodec(): ConformanceValueCodec {
  const scalar = (value: unknown, path: string[]): ConformanceValue => {
    try {
      return JSON.parse(typedFrameText(value)) as ConformanceValue;
    } catch (err) {
      throw refuse(path, `is refused by the typed frame (${(err as Error).message})`);
    }
  };

  const write = (value: unknown, path: string[]): ConformanceValue => {
    if (value === undefined) throw refuse(path, "is undefined, which is not a CEL value");
    if (isCelTypeValue(value)) return { [CEL_TAG]: "type", value: recordedTypeName(value.name) };
    if (isCelOptional(value)) {
      if (!value.present) return { [CEL_TAG]: "optional" };
      return { [CEL_TAG]: "optional", value: write(value.held, [...path, "value"]) };
    }
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) throw refuse(path, "is a sparse or decorated array");
      return value.map((item, index) => write(item, [...path, String(index)]));
    }
    if (isCelMap(value)) {
      return writeMap([...value.entries.values()].map((entry) => [entry.key, entry.value]), path);
    }
    if (value instanceof Map) return writeMap([...value], path);
    if (isCelError(value)) throw refuse(path, `is the CEL error '${value.message}', which is not a value`);
    if (isCelRecord(value)) return writeMap(Object.entries(value), path);
    return scalar(value, path);
  };

  const writeMap = (entries: [unknown, unknown][], path: string[]): ConformanceValue => {
    const seen = new Set<string>();
    const pairs: { key: ConformanceValue; order: string; value: ConformanceValue }[] = [];
    let plain = true;
    for (const [key, entry] of entries) {
      const identity = mapKeyIdentity(key);
      if (identity === undefined) throw refuse(path, "holds a key that is not an int, uint, bool or string");
      if (seen.has(identity)) throw refuse(path, `holds two keys equal to ${String(key)}`);
      seen.add(identity);
      if (typeof key !== "string" || key === TYPED_FRAME_TAG || key === CEL_TAG) plain = false;
      const encodedKey = scalar(key, path);
      const order = typeof key === "string" ? key : JSON.stringify(encodedKey);
      pairs.push({ key: encodedKey, order, value: write(entry, [...path, String(key)]) });
    }
    if (plain) {
      pairs.sort((a, b) => compareCodeUnits(a.order, b.order));
      return Object.fromEntries(pairs.map((pair) => [pair.key as string, pair.value]));
    }
    pairs.sort((a, b) => compareCodeUnits(JSON.stringify(a.key), JSON.stringify(b.key)));
    return { [TYPED_FRAME_TAG]: "map", value: pairs.map((pair) => [pair.key, pair.value]) };
  };

  const read = (node: ConformanceValue, path: string[]): unknown => {
    if (node === null || typeof node !== "object") return readScalar(node, path);
    if (Array.isArray(node)) return node.map((item, index) => read(item, [...path, String(index)]));
    if (Object.prototype.hasOwnProperty.call(node, CEL_TAG)) return readCel(node, path);
    if (Object.prototype.hasOwnProperty.call(node, TYPED_FRAME_TAG)) {
      return node[TYPED_FRAME_TAG] === "map" ? readMap(node, path) : readScalar(node, path);
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(node)) {
      Object.defineProperty(out, key, {
        value: read(entry, [...path, key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  };

  /** The frame's own reading, with the one representation the CEL domain spells its own
   *  way read back into it. */
  const readScalar = (node: ConformanceValue, path: string[]): unknown => {
    let value: unknown;
    try {
      value = decodeTypedFrame(JSON.stringify(node));
    } catch (err) {
      throw unreadable(path, `is refused by the typed frame (${(err as Error).message})`);
    }
    if (!(value instanceof Date)) return value;
    const millis = BigInt(value.getTime());
    const built = celTimestamp(millis / 1000n, Number(((millis % 1000n) + 1000n) % 1000n) * NANOS_PER_MILLISECOND);
    if (isCelError(built)) throw unreadable(path, `is an instant the CEL domain refuses (${built.message})`);
    return built;
  };

  const readCel = (node: { [key: string]: ConformanceValue }, path: string[]): unknown => {
    const keys = Object.keys(node).sort();
    const form = node[CEL_TAG];
    if (form === "type" && keys.join() === "$cel,value" && typeof node.value === "string") {
      return celTypeValue(engineTypeName(node.value));
    }
    if (form === "optional" && keys.join() === "$cel") return celNone();
    if (form === "optional" && keys.join() === "$cel,value") {
      return celSome(read(node.value!, [...path, "value"]) as CelValue);
    }
    throw unreadable(path, `is not a '${CEL_TAG}' type or optional form`);
  };

  const readMap = (node: { [key: string]: ConformanceValue }, path: string[]): unknown => {
    const pairs = node.value;
    if (Object.keys(node).length !== 2 || !Array.isArray(pairs)) {
      throw unreadable(path, "is a tagged map, which carries exactly a list of pairs as its 'value'");
    }
    const flat: CelValue[] = [];
    pairs.forEach((pair, index) => {
      const at = [...path, "value", String(index)];
      if (!Array.isArray(pair) || pair.length !== 2) throw unreadable(at, "is not a [key, value] pair");
      const key = readScalar(pair[0]!, [...at, "0"]);
      if (mapKeyIdentity(key) === undefined) throw unreadable(at, "holds a key that is not an int, uint, bool or string");
      flat.push(key as CelMapKey as CelValue, read(pair[1]!, [...at, "1"]) as CelValue);
    });
    const built = celMapFromEntries(flat);
    if (isCelError(built)) throw unreadable(path, `is a map the CEL domain refuses (${built.message})`);
    return built;
  };

  return {
    encode(value) {
      const encoded = write(value, []);
      const again = write(read(encoded, []), []);
      if (JSON.stringify(again) !== JSON.stringify(encoded)) {
        throw refuse([], `does not survive the round trip: ${JSON.stringify(encoded)} reads back as ${JSON.stringify(again)}`);
      }
      return encoded;
    },
    decode(node) {
      const value = read(node, []);
      const canonical = write(value, []);
      if (JSON.stringify(canonical) !== JSON.stringify(node)) {
        throw unreadable([], `is not in its canonical form ${JSON.stringify(canonical)}`);
      }
      return value;
    },
  };
}
