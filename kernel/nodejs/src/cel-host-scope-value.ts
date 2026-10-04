/**
 * A host value on its way INTO a CEL activation, as a value the member-read seam can read.
 *
 * `request`, `inputs`, `item` and every other binding a controller hands the kernel is a CEL
 * binding, so each member of it has to BE a CEL value — and a map is a plain object: the seam
 * resolves a string key against an object whose prototype is `Object.prototype` or `null`,
 * and answers "this value holds no members" for anything else. It never performs a host
 * property read, which is what stops a computed key (`request.query[k]`) from reaching a
 * prototype, a method or `constructor`.
 *
 * **A framework's own bag is routinely neither.** Fastify's query parser builds each one as
 * `new Empty()`, whose prototype is a null-prototype object — prototype-free data by intent,
 * and a container the engine cannot read. Every handler reading the query string answered
 * 500. The module's controller was repaired for its own two bags, but the repair has to be
 * here: `@telorun/sdk` is external and collapsed to the running kernel's copy, so a module
 * PUBLISHED before the repair carries a controller that still hands the bag over raw. Fixing
 * it only in the module would have broken `request.query` for every app importing any
 * published `http-server` — the artifacts in users' lock files, which cannot be fixed
 * retroactively. The kernel is the side that ships with the engine, so it is the side that
 * can repair them.
 *
 * **Exactly one shape is converted: prototype-free data.** A value whose prototype is
 * `Object.prototype` or `null` is already readable and is returned by identity — which covers
 * every branded value (a duration, an instant, a uint, the map container), since a brand is a
 * plain object carrying a type key. Everything else keeps its prototype and is left alone: a
 * `Date`, a `Map`, a typed array, a `Stream`, a live resource instance. Converting one of
 * those would be inventing a meaning for a value that was never in the domain, and descending
 * into a live instance walks the whole kernel.
 *
 * So the test is the prototype's OWN shape rather than a list of host classes to exclude: a
 * bare data holder's prototype has a null prototype and no own properties, where a class's
 * prototype carries its methods. It is deliberately narrow. A controller binding a class
 * instance still reaches the engine's refusal, which is the honest answer — that value is not
 * a map, and no normalization makes it one.
 */

import { isCelRecord } from "@telorun/sdk";

/**
 * **Nothing is memoized, deliberately.** A converted value is a COPY, and the bag it was
 * copied from is a live host object the framework still owns: a route's validator coerces
 * the query IN PLACE, and a request guard reads the binding before that happens. A cached
 * copy taken during the guard therefore held `archived: "true"` where the coerced bag held
 * `true`, and the handler was handed the stale one — a boolean query parameter arrived as a
 * string and failed the contract it was declared against. Caching a copy of a value someone
 * else mutates is the bug; the conversion is cheap and runs per expression instead.
 */

/** How deep a bag is followed. A transport's bags nest shallowly; the bound exists so a
 *  pathological structure cannot turn one binding into an unbounded walk. */
const MAX_DEPTH = 8;

/** Whether `value`'s prototype says it is data with no prototype of its own. */
function isPrototypeFreeData(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype === null || prototype === Object.prototype) return false;
  // A bare holder: its prototype is itself prototype-free and carries nothing.
  return (
    Object.getPrototypeOf(prototype) === null && Object.getOwnPropertyNames(prototype).length === 0
  );
}

/**
 * `value` as the CEL value domain reads it, or `value` itself where nothing needed to move.
 * Returned by identity whenever no conversion happened, so an activation binding that was
 * already in the domain costs one type test.
 */
export function celHostScopeValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return value;

  if (Array.isArray(value)) {
    let moved = false;
    const out: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      const next = celHostScopeValue(value[i], depth + 1);
      out[i] = next;
      if (next !== value[i]) moved = true;
    }
    return moved ? out : value;
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype === null || prototype === Object.prototype) {
    // **A BRANDED value is a plain object**, so it reaches here — and rebuilding one from
    // its entries drops the symbol it carries its type under, turning a duration into a
    // pair of numbers. `isCelRecord` is false for exactly those, which is the one question
    // that separates them from data, so they are returned untouched.
    if (!isCelRecord(value)) return value;
    // Already readable. Its MEMBERS may not be, so a plain object holding a bag is
    // rebuilt — but only when something below actually moved.
    let moved = false;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const held = (value as Record<string, unknown>)[key];
      const next = celHostScopeValue(held, depth + 1);
      out[key] = next;
      if (next !== held) moved = true;
    }
    return moved ? out : value;
  }

  if (!isPrototypeFreeData(value)) return value;

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    out[key] = celHostScopeValue((value as Record<string, unknown>)[key], depth + 1);
  }
  return out;
}
