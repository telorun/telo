/**
 * Building a CEL map, and the one identity a key has.
 *
 * A map's entries live in a `Map` keyed by the **canonical text** of each key, never by
 * a property name. Two consequences, both load-bearing:
 *
 * - A map holds CEL's four key types (int, uint, bool, string) in one container, and an
 *   int key and a uint key of the same number are **one** key, because CEL equality
 *   makes them equal — so a literal writing both is a duplicate rather than two entries.
 * - Nothing a key spells can reach a prototype, a method or an inherited member. A map
 *   built from `{'__proto__': 1}` holds `__proto__` as data and reads it back as data;
 *   dropping such a key would be swallowing what the author wrote.
 */

import type { CelMap, CelMapValueEntry, CelValue } from "./cel-value.js";
import {
  CEL_VALUE_TYPE,
  celError,
  isCelError,
  isCelUint,
  type CelError,
} from "./cel-value.js";
import type { SourceRange } from "./syntax-tree.js";

/**
 * The text that identifies a key. `n` covers the numeric types together: CEL equality
 * makes `1`, `1u` and `1.0` one key, so a map carrying two of them is not a map and a
 * lookup by any of the three finds the entry — which is what
 * `{1u: 1.0, 2: 2.0, 3u: 3.0}[?3.0]` reads. A double that is not whole identifies
 * nothing, since no entry can hold it.
 */
export function mapKeyIdentity(key: CelValue): string | undefined {
  if (typeof key === "string") return `s${key}`;
  if (typeof key === "boolean") return `b${key}`;
  if (typeof key === "bigint") return `n${key}`;
  if (isCelUint(key)) return `n${key.value}`;
  if (typeof key === "number" && Number.isInteger(key)) return `n${BigInt(key)}`;
  return undefined;
}

/** An empty map, for a literal with no entries. */
export function celMapOf(entries: ReadonlyMap<string, CelMapValueEntry>): CelMap {
  return { [CEL_VALUE_TYPE]: "map", entries };
}

/**
 * A map from its entries in written order, or the error that stops it: a key of a type
 * no map is keyed by, or two keys CEL equality makes one.
 */
export function celMapFromEntries(
  pairs: readonly (readonly [CelValue, CelValue])[],
  range?: SourceRange,
): CelMap | CelError {
  const entries = new Map<string, CelMapValueEntry>();
  for (const [key, value] of pairs) {
    if (isCelError(key)) return key;
    if (isCelError(value)) return value;
    // A map is **built** with an int, uint, bool or string key: a double is not a key
    // type, even one that is whole. It still LOOKS one up, because `{1u: …}[?1.0]` reads
    // the entry — equality across the numeric types holds for a key as for a value.
    const identity = typeof key === "number" ? undefined : mapKeyIdentity(key);
    if (identity === undefined) {
      return celError(
        "unsupported_key_type",
        "a map is keyed by an int, a uint, a bool or a string",
        range,
      );
    }
    if (entries.has(identity)) {
      return celError("duplicate_map_key", `the key ${describeKey(key)} is written twice`, range);
    }
    entries.set(identity, { key, value });
  }
  return celMapOf(entries);
}

function describeKey(key: CelValue): string {
  if (typeof key === "string") return JSON.stringify(key);
  if (isCelUint(key)) return `${key.value}u`;
  return String(key);
}

/** Every key of a map, in insertion order — what a comprehension ranges over. */
export function celMapKeys(map: CelMap): CelValue[] {
  return [...map.entries.values()].map((entry) => entry.key);
}
