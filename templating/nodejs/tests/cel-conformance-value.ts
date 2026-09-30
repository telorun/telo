/**
 * The conformance value (`templating/cel-conformance/README.md`): the typed frame
 * held as a JSON value, plus the `$cel` forms for a type and an optional.
 */
import { Optional, type Environment } from "@marcbachmann/cel-js";
import { decodeTypedFrame, encodeTypedFrame, TYPED_FRAME_TAG, UnsignedInt } from "@telorun/sdk";

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

function refuse(path: readonly string[], detail: string): Error {
  return new Error(`Cannot write a conformance value: '/${path.join("/")}' ${detail}.`);
}

function unreadable(path: readonly string[], detail: string): Error {
  return new Error(`Cannot read a conformance value: '/${path.join("/")}' ${detail}.`);
}

/** Every type value `env` names, by the name cel-js prints: a type decodes to the
 *  instance the language itself hands out, since cel-js compares types by identity. */
function namedTypes(env: Environment, typeClass: Function): Map<string, object> {
  const types = new Map<string, object>();
  const collect = (value: unknown) => {
    if (value instanceof typeClass) types.set((value as { name: string }).name, value as object);
    else if (value instanceof Map) value.forEach(collect);
    else if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      Object.values(value).forEach(collect);
    }
  };
  for (const variable of env.getDefinitions().variables) collect(env.evaluate(variable.name));
  return types;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function mapKeyIdentity(key: unknown): string | undefined {
  if (typeof key === "string") return `s${key}`;
  if (typeof key === "boolean") return `b${key}`;
  if (typeof key === "bigint") return `n${key}`;
  if (key instanceof UnsignedInt) return `n${key.valueOf()}`;
  return undefined;
}

export function conformanceValueCodec(env: Environment): ConformanceValueCodec {
  const typeClass = (env.evaluate("int") as object).constructor;
  const types = namedTypes(env, typeClass);

  const scalar = (value: unknown, path: string[]): ConformanceValue => {
    try {
      return JSON.parse(encodeTypedFrame(value)) as ConformanceValue;
    } catch (err) {
      throw refuse(path, `is refused by the typed frame (${(err as Error).message})`);
    }
  };

  const write = (value: unknown, path: string[]): ConformanceValue => {
    if (value === undefined) throw refuse(path, "is undefined, which is not a CEL value");
    if (value === null || typeof value !== "object" || value instanceof UnsignedInt || value instanceof Uint8Array) {
      return scalar(value, path);
    }
    if (value instanceof typeClass) {
      const name = (value as { name: string }).name;
      if (types.get(name) !== value) throw refuse(path, `is the type '${name}', which the environment does not name`);
      return { [CEL_TAG]: "type", value: name };
    }
    if (value instanceof Optional) {
      if (!value.hasValue()) return { [CEL_TAG]: "optional" };
      return { [CEL_TAG]: "optional", value: write(value.value(), [...path, "value"]) };
    }
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) throw refuse(path, "is a sparse or decorated array");
      return value.map((item, index) => write(item, [...path, String(index)]));
    }
    if (value instanceof Map || isPlainObject(value)) {
      return writeMap(value instanceof Map ? [...value] : Object.entries(value), path);
    }
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

  const readScalar = (node: ConformanceValue, path: string[]): unknown => {
    try {
      return decodeTypedFrame(JSON.stringify(node));
    } catch (err) {
      throw unreadable(path, `is refused by the typed frame (${(err as Error).message})`);
    }
  };

  const readCel = (node: { [key: string]: ConformanceValue }, path: string[]): unknown => {
    const keys = Object.keys(node).sort();
    const form = node[CEL_TAG];
    if (form === "type" && keys.join() === "$cel,value" && typeof node.value === "string") {
      const type = types.get(node.value);
      if (!type) throw unreadable(path, `names the type '${node.value}', which the environment does not name`);
      return type;
    }
    if (form === "optional" && keys.join() === "$cel") return Optional.none();
    if (form === "optional" && keys.join() === "$cel,value") {
      return Optional.of(read(node.value!, [...path, "value"]));
    }
    throw unreadable(path, `is not a '${CEL_TAG}' type or optional form`);
  };

  const readMap = (node: { [key: string]: ConformanceValue }, path: string[]): Map<unknown, unknown> => {
    const pairs = node.value;
    if (Object.keys(node).length !== 2 || !Array.isArray(pairs)) {
      throw unreadable(path, "is a tagged map, which carries exactly a list of pairs as its 'value'");
    }
    const out = new Map<unknown, unknown>();
    pairs.forEach((pair, index) => {
      const at = [...path, "value", String(index)];
      if (!Array.isArray(pair) || pair.length !== 2) throw unreadable(at, "is not a [key, value] pair");
      const key = readScalar(pair[0]!, [...at, "0"]);
      if (mapKeyIdentity(key) === undefined) throw unreadable(at, "holds a key that is not an int, uint, bool or string");
      out.set(key, read(pair[1]!, [...at, "1"]));
    });
    return out;
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
