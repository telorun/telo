/**
 * Building a CEL map, and the one identity a key has.
 *
 * A map's entries live in a `Map` keyed by each key's **own typed value**, never by a
 * property name. Three consequences, all load-bearing:
 *
 * - A map holds CEL's four key types (int, uint, bool, string) in one container, and an
 *   int key and a uint key of the same number are **one** key, because CEL equality
 *   makes them equal — so a literal writing both is a duplicate rather than two entries.
 * - Nothing a key spells can reach a prototype, a method or an inherited member. A map
 *   built from `{'__proto__': 1}` holds `__proto__` as data and reads it back as data;
 *   dropping such a key would be swallowing what the author wrote.
 * - The types separate themselves. A `Map` compares its keys by type as well as value, so
 *   a string `"1"` and an int `1` are distinct keys with nothing prefixed to say so — and a
 *   second engine keys an entry by its own discriminant rather than reproducing this one's
 *   text byte for byte.
 */

import type { CelMap, CelMapKey, CelMapValueEntry, CelValue } from "./cel-value.js";
import {
  CEL_VALUE_TYPE,
  celError,
  isCelError,
  isCelUint,
  type CelError,
} from "./cel-value.js";
import type { SourceRange } from "./syntax-tree.js";

/**
 * What identifies a key. The `bigint` covers the numeric types together: CEL equality
 * makes `1`, `1u` and `1.0` one key, so a map carrying two of them is not a map and a
 * lookup by any of the three finds the entry — which is what
 * `{1u: 1.0, 2: 2.0, 3u: 3.0}[?3.0]` reads. A double that is not whole identifies
 * nothing, since no entry can hold it.
 *
 * A string and a bool identify themselves, and nothing is prefixed to keep the types
 * apart: a `Map` key of one type never equals a key of another, so `"1"` and `1` are
 * distinct keys and `"true"` is not `true`.
 */
export function mapKeyIdentity(key: CelValue): CelMapKey | undefined {
  const held = typeof key;
  if (held === "string" || held === "boolean" || held === "bigint") return key as CelMapKey;
  if (held === "number") return Number.isInteger(key) ? BigInt(key as number) : undefined;
  return isCelUint(key) ? key.value : undefined;
}

/** An empty map, for a literal with no entries. */
export function celMapOf(entries: ReadonlyMap<CelMapKey, CelMapValueEntry>): CelMap {
  return { [CEL_VALUE_TYPE]: "map", entries };
}

/**
 * A map from its entries in written order, or the error that stops it: a key of a type
 * no map is keyed by, or two keys CEL equality makes one.
 *
 * The entries arrive **flat** — key, value, key, value — because a literal of n entries
 * then costs one allocation rather than one per entry, and both backends write the same
 * call. A duplicate is caught by the size not moving, which is the one hash lookup the
 * insert already performs.
 */
export function celMapFromEntries(flat: readonly CelValue[], range?: SourceRange): CelMap | CelError {
  const entries = new Map<CelMapKey, CelMapValueEntry>();
  for (let at = 0; at < flat.length; at += 2) {
    const key = flat[at] as CelValue;
    const value = flat[at + 1] as CelValue;
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
    const before = entries.size;
    entries.set(identity, { key, value });
    if (entries.size === before) {
      return celError("duplicate_map_key", `the key ${describeKey(key)} is written twice`, range);
    }
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
