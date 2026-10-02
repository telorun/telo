/**
 * The member-read seam: **one** lookup, for every form a read is written in.
 *
 * `a.b`, `a['b']`, `a[expr]`, `a.?b`, `a[?expr]`, a macro's field read and the presence
 * question `has()` all resolve here, through a single lookup over the value's **own**
 * entries. Neither backend ever performs a host property read, so no key — however it
 * was computed — can reach a prototype, a method or a function property: `a['length']`
 * on a map is a missing key, not `0`, and `a[request.query.k]` cannot reach
 * `constructor`.
 *
 * That is why the reserved-word set holds CEL's own words and nothing else. A word list
 * is the wrong instrument: a member *name* is written by the author, while a member
 * *key* can come from a request, so no list at any position touches the form an
 * attacker can actually reach — and refusing `__proto__` as a name would make a
 * resource that may legally be called that unreadable through CEL.
 *
 * A key the value does not hold is the `no_such_key` **error value**, which
 * participates in short-circuit. Never `undefined` passed along.
 */

import { celMapKeys, mapKeyIdentity } from "./cel-map-value.js";
import type { CelValue } from "./cel-value.js";
import { celError, isCelMap, isCelRecord, isCelUint, type CelError } from "./cel-value.js";
import type { SourceRange } from "./syntax-tree.js";

/**
 * What one lookup found. The four refusals are **symbols**, not objects: a lookup happens
 * on nearly every evaluation, and a wrapper object per read is an allocation per read.
 * `MISSING` is a key the container does not hold — which `has()` answers `false` for and a
 * read turns into `no_such_key`; the other three are mistakes in the read itself.
 */
export const MISSING = Symbol("cel.lookup.missing");
export const OUT_OF_RANGE = Symbol("cel.lookup.outOfRange");
export const UNSUPPORTED_CONTAINER = Symbol("cel.lookup.unsupportedContainer");
export const UNSUPPORTED_KEY = Symbol("cel.lookup.unsupportedKey");

export type Lookup =
  | CelValue
  | typeof MISSING
  | typeof OUT_OF_RANGE
  | typeof UNSUPPORTED_CONTAINER
  | typeof UNSUPPORTED_KEY;

/** An int-valued index, or nothing when the value is of no index type. */
function indexOf(key: CelValue): bigint | undefined {
  if (typeof key === "bigint") return key;
  if (isCelUint(key)) return key.value;
  // A double that holds a whole number indexes a list: a `dyn` arithmetic result is a
  // double, and cel-spec indexes with it where it is integral.
  if (typeof key === "number" && Number.isInteger(key)) return BigInt(key);
  return undefined;
}

/**
 * The single lookup. It is total over the value domain: a container that holds no members
 * at all answers `UNSUPPORTED_CONTAINER` rather than falling back to a property read that
 * might find `length`, `name`, `call` or `apply`.
 */
export function celLookup(container: CelValue, key: CelValue): Lookup {
  if (typeof key === "string" && isCelRecord(container)) {
    // An OWN entry, never an inherited one: a host's object is data here.
    return Object.prototype.hasOwnProperty.call(container, key)
      ? (container[key] as CelValue)
      : MISSING;
  }
  if (isCelMap(container)) {
    const identity = mapKeyIdentity(key);
    if (identity === undefined) return UNSUPPORTED_KEY;
    const entry = container.entries.get(identity);
    return entry ? entry.value : MISSING;
  }
  if (Array.isArray(container)) {
    const at = indexOf(key);
    if (at === undefined) return UNSUPPORTED_KEY;
    if (at < 0n || at >= BigInt(container.length)) return OUT_OF_RANGE;
    return container[Number(at)] as CelValue;
  }
  if (isCelRecord(container)) return UNSUPPORTED_KEY;
  return UNSUPPORTED_CONTAINER;
}

/** The value at a key, or the error a failed lookup is. */
export function celRead(container: CelValue, key: CelValue, range?: SourceRange): CelValue | CelError {
  const found = celLookup(container, key);
  if (typeof found !== "symbol") return found;
  return lookupError(found, key, range);
}

/** The error a refused lookup is. */
export function lookupError(found: symbol, key: CelValue, range?: SourceRange): CelError {
  if (found === MISSING) return celError("no_such_key", `no such key: ${describe(key)}`, range);
  if (found === OUT_OF_RANGE) {
    return celError("index_out_of_range", `index out of range: ${describe(key)}`, range);
  }
  if (found === UNSUPPORTED_KEY) {
    return celError("unsupported_key_type", `${describe(key)} cannot name an entry of this value`, range);
  }
  return celError("unsupported_container", "this value holds no members", range);
}

/**
 * Whether a key is there — `has(a.b)`. It asks about presence, so a missing key is
 * `false` rather than the error a read would be; a container that holds no members at
 * all is still a mistake in the question.
 */
export function celHas(container: CelValue, key: CelValue, range?: SourceRange): boolean | CelError {
  const found = celLookup(container, key);
  if (typeof found !== "symbol") return true;
  if (found === MISSING || found === OUT_OF_RANGE) return false;
  return lookupError(found, key, range);
}

/** The elements a comprehension ranges over: a list's items, a map's keys. */
export function celIterable(container: CelValue, range?: SourceRange): CelValue[] | CelError {
  if (Array.isArray(container)) return [...container];
  if (isCelMap(container)) return celMapKeys(container);
  if (isCelRecord(container)) return Object.keys(container);
  return celError("unsupported_container", "a comprehension reads a list or a map", range);
}

function describe(key: CelValue): string {
  if (typeof key === "string") return JSON.stringify(key);
  if (isCelUint(key)) return `${key.value}`;
  if (typeof key === "bigint") return `${key}`;
  return String(key);
}
