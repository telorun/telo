/**
 * The plain JSON writer — what every boundary read OUTSIDE Telo writes.
 *
 * A transport body, a log line, a debug-wire payload or a CLI document is read by
 * something that is not a Telo runtime, so it gets no type tags: each CEL value
 * is written as the one plain form its type declares, keyed on the VALUE, and a
 * reader recovers the type from the schema it was promised. The typed frame
 * (`typed-frame.ts`) is the other half, for readers that are a Telo runtime.
 *
 * - a timestamp, a duration and bytes are their plain encoding's text
 *   ({@link PLAIN_ENCODINGS});
 * - a `uint` is its decimal digits, as an int64 is;
 * - NaN and ±Infinity are the strings `"NaN"`, `"Infinity"` and `"-Infinity"` —
 *   JSON has no number for them, and these are the spellings the protobuf JSON
 *   mapping (and so OTLP/JSON) uses; a negative zero is `0`, as RFC 8785 writes
 *   it;
 * - a map whose keys are not strings is an object keyed by each key's text
 *   (`1`, `true`), the protobuf JSON rule for map keys. Two keys with one text
 *   cannot both be written and are refused rather than one silently dropped.
 *
 * Anything outside the CEL value domain is left for the serializer, so a host
 * object keeps its own `toJSON` — this writer adds forms, it does not narrow what
 * a boundary accepts.
 */
import { Duration, UnsignedInt } from "./cel-value-identity.js";
import { InvokeError } from "./invoke-error.js";
import { requirePlainEncoding } from "./plain-encoding.js";
import { plainEncodingOf } from "./value-type.js";

const bytesEncoding = requirePlainEncoding("base64url", "The plain JSON writer");
const timestampEncoding = requirePlainEncoding("rfc3339", "The plain JSON writer");
const durationEncoding = requirePlainEncoding("cel-duration", "The plain JSON writer");

/**
 * The plain form of a CEL scalar JSON cannot carry as itself, or `undefined` when
 * `value` is not one — a string, a finite number, a boolean, a container or a
 * host object is already its own form. A `uint` becomes a `bigint`, which every
 * JSON boundary in a Telo process writes as its exact digits.
 */
export function plainScalar(value: unknown): string | number | bigint | undefined {
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (value === Number.POSITIVE_INFINITY) return "Infinity";
    if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
    return Object.is(value, -0) ? 0 : undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  if (value instanceof UnsignedInt) return value.valueOf() as bigint;
  if (value instanceof Duration) return durationEncoding.encode(value);
  if (value instanceof Uint8Array) return bytesEncoding.encode(value);
  if (value instanceof Date && !Number.isNaN(value.getTime())) return timestampEncoding.encode(value);
  return undefined;
}

/** The text a map key is written under: a string as itself, an int or uint as
 *  its digits, a bool as `true` / `false`. */
export function plainMapKey(key: unknown): string {
  if (typeof key === "string") return key;
  if (typeof key === "bigint" || typeof key === "boolean") return String(key);
  if (key instanceof UnsignedInt) return String(key.valueOf());
  throw new InvokeError(
    "ERR_PLAIN_JSON_UNWRITABLE",
    `Cannot write a map key that is ${typeof key === "number" ? `the number ${key}` : typeof key} as plain JSON; a CEL map key is an int, uint, bool or string.`,
  );
}

/**
 * `value` with every CEL value JSON cannot carry replaced by its plain form, and
 * every `Map` by an object — a tree any JSON serializer writes correctly, a
 * schema-driven one included. Containers are copied only where something inside
 * them changed.
 */
export function toPlainJson(value: unknown): unknown {
  return walk(value, []);
}

function walk(value: unknown, ancestors: object[]): unknown {
  const scalar = plainScalar(value);
  if (scalar !== undefined) return scalar;
  if (typeof value !== "object" || value === null) return value;
  if (ancestors.includes(value)) {
    throw new InvokeError("ERR_PLAIN_JSON_UNWRITABLE", "Cannot write a value that contains itself as plain JSON.");
  }
  ancestors.push(value);
  try {
    if (Array.isArray(value)) {
      let copy: unknown[] | undefined;
      value.forEach((item, index) => {
        const written = walk(item, ancestors);
        if (written !== item) (copy ??= value.slice())[index] = written;
      });
      return copy ?? value;
    }
    if (value instanceof Map) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of value) {
        const text = plainMapKey(key);
        if (Object.prototype.hasOwnProperty.call(out, text)) {
          throw new InvokeError(
            "ERR_PLAIN_JSON_UNWRITABLE",
            `Cannot write a map as plain JSON: two of its keys are written as '${text}'.`,
          );
        }
        Object.defineProperty(out, text, {
          value: walk(item, ancestors),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    let copy: Record<string, unknown> | undefined;
    for (const [key, item] of Object.entries(value)) {
      const written = walk(item, ancestors);
      if (written !== item) (copy ??= { ...(value as Record<string, unknown>) })[key] = written;
    }
    return copy ?? value;
  } finally {
    ancestors.pop();
  }
}

/** JSON text of `value` in the plain form, independent of whether the process
 *  has installed the kernel's `BigInt` JSON form. */
export function writePlainJson(value: unknown, space?: number): string {
  return JSON.stringify(
    toPlainJson(value),
    function (this: Record<string, unknown>, key, item) {
      const source = this[key];
      return typeof source === "bigint" ? rawJson(source.toString()) : item;
    },
    space,
  );
}

function rawJson(text: string): unknown {
  const raw = (JSON as unknown as { rawJSON?: (text: string) => unknown }).rawJSON;
  if (!raw) throw new Error("Writing a 64-bit integer as plain JSON needs JSON.rawJSON, which this runtime lacks.");
  return raw(text);
}

const SCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"] as const;
const SCHEMA_LISTS = ["anyOf", "oneOf", "allOf", "prefixItems"] as const;
const SCHEMA_NODES = [
  "items",
  "additionalProperties",
  "additionalItems",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
] as const;

/**
 * The schema a reader outside Telo is given for a slot: every node declaring an
 * instance value type with a plain encoding is replaced by the schema of its
 * written text, keeping the node's own annotations (title, description). Nodes
 * declaring a `json` or `live` type are left as they are. Returns `schema` itself
 * when it declares no such node, so a caller can tell whether a slot reads
 * anything from its plain encoding.
 */
export function plainSchemaOf<T>(schema: T): T {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return schema;
  const node = schema as Record<string, unknown>;
  const plain = plainEncodingOf(node);
  if (plain) {
    const { ["x-telo-type"]: annotation, ...rest } = node;
    return { ...rest, ...plain.schema } as T;
  }
  let copy: Record<string, unknown> | undefined;
  const set = (key: string, next: unknown) => {
    if (next !== node[key]) (copy ??= { ...node })[key] = next;
  };
  for (const key of SCHEMA_NODES) {
    if (node[key] !== undefined) set(key, plainSchemaOf(node[key]));
  }
  for (const key of SCHEMA_LISTS) {
    const list = node[key];
    if (!Array.isArray(list)) continue;
    const mapped = list.map((item) => plainSchemaOf(item));
    if (mapped.some((item, index) => item !== list[index])) set(key, mapped);
  }
  for (const key of SCHEMA_MAPS) {
    const map = node[key];
    if (typeof map !== "object" || map === null || Array.isArray(map)) continue;
    let mapCopy: Record<string, unknown> | undefined;
    for (const [name, child] of Object.entries(map)) {
      const next = plainSchemaOf(child);
      if (next !== child) (mapCopy ??= { ...(map as Record<string, unknown>) })[name] = next;
    }
    if (mapCopy) set(key, mapCopy);
  }
  if (Array.isArray(node.items)) {
    const mapped = node.items.map((item) => plainSchemaOf(item));
    if (mapped.some((item, index) => item !== (node.items as unknown[])[index])) set("items", mapped);
  }
  return (copy ?? node) as T;
}
