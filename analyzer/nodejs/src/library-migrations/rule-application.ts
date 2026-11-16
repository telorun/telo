/**
 * One `rewrite` rule applied to one matched node, as data: the node as found in,
 * the rewritten node or the cause it cannot be rewritten out. Nothing is
 * mutated: every container on a changed path is a new one, and everything the
 * rule does not mention stays the very object it was, so a caller can tell what
 * the rule wrote from what it kept by identity.
 *
 * The change is built in one step from the node as found (`The change` in the
 * library migration spec): delete each `remove:` pointer and `move:` source,
 * merge `set:` (map over map recursively, any other value replaces, null writes
 * null), then place every moved or copied node exactly as written. Whether a
 * destination is held, or two writes reach one position, is judged against the
 * node as found.
 *
 * Browser-safe: no Node built-ins.
 */
import type { MigrationRule } from "./declaration.js";
import { migrationPointerSegments } from "./declaration.js";
import { isExpansionSentinel } from "@telorun/templating";
import { isMigrationMap, isOpaqueMigrationValue } from "./match.js";

/** A `kind:` a `set:` writes, spelled for the file holding the node, or why it
 *  cannot be. */
export type KindSpelling = { readonly kind: string } | { readonly failure: string };

export type RuleApplication = { readonly value: unknown } | { readonly failure: string };

/** What a `resolve` binding reads: the declaration's value, or why a copy from
 *  it cannot read it. */
export type BindingReading = { readonly value: unknown } | { readonly unreadable: string };

type Segments = readonly string[];

/** A copy of `value` whose plain containers — an expansion construct's
 *  included, since its branches are manifest content — are new and whose opaque
 *  content (a tag, a compiled value) is the same object. */
export function cloneMigrationTree(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneMigrationTree);
  if (value !== null && typeof value === "object" && (!isOpaqueMigrationValue(value) || isExpansionSentinel(value))) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    // Every own key, symbol stamps and non-enumerable ones included.
    const out: Record<PropertyKey, unknown> = Object.create(prototype);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if ("value" in descriptor) descriptor.value = cloneMigrationTree(descriptor.value);
      Object.defineProperty(out, key, descriptor);
    }
    return out;
  }
  return value;
}

const pointerText = (segments: Segments) =>
  segments.length === 0 ? "/" : segments.map((s) => `/${s.replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");

const indexOf = (segment: string, length: number): number | undefined => {
  if (!/^(0|[1-9][0-9]*)$/.test(segment)) return undefined;
  const index = Number(segment);
  return index < length ? index : undefined;
};

/** What `segments` names in `value`, or why reading it would read a tag. */
function read(value: unknown, segments: Segments): { found: unknown } | { opaque: Segments } {
  let at = value;
  for (let i = 0; i < segments.length; i++) {
    if (at === undefined) return { found: undefined };
    if (isOpaqueMigrationValue(at)) return { opaque: segments.slice(0, i) };
    const segment = segments[i]!;
    if (Array.isArray(at)) {
      const index = indexOf(segment, at.length);
      at = index === undefined ? undefined : at[index];
    } else if (isMigrationMap(at)) {
      at = Object.hasOwn(at, segment) ? at[segment] : undefined;
    } else {
      return { found: undefined };
    }
  }
  return { found: at };
}

/** `value` with what `segments` names deleted; containers on the path new. */
function without(value: unknown, segments: Segments): unknown {
  if (segments.length === 0) return value;
  const [head, ...rest] = segments as [string, ...string[]];
  if (Array.isArray(value)) {
    const index = indexOf(head, value.length);
    if (index === undefined) return value;
    const copy = [...value];
    if (rest.length === 0) copy.splice(index, 1);
    else copy[index] = without(copy[index], rest);
    return copy;
  }
  if (!isMigrationMap(value) || !Object.hasOwn(value, head)) return value;
  const copy = { ...value };
  if (rest.length === 0) delete copy[head];
  else copy[head] = without(copy[head], rest);
  return copy;
}

/** The removals ordered so that deleting one never shifts another as found:
 *  list items of one list go by descending index. */
function inRemovalOrder(removals: readonly Segments[]): Segments[] {
  const index = (segment: string | undefined) => (segment !== undefined && /^(0|[1-9][0-9]*)$/.test(segment) ? Number(segment) : undefined);
  return [...removals].sort((a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] === b[i]) continue;
      const x = index(a[i]);
      const y = index(b[i]);
      return x !== undefined && y !== undefined ? y - x : 0;
    }
    return 0;
  });
}

/** `value` with `placed` added at `segments` as JSON Patch `add` does, missing
 *  maps and lists created on the way. */
function added(value: unknown, segments: Segments, placed: unknown, at: Segments = []): unknown {
  if (segments.length === 0) return placed;
  const [head, ...rest] = segments as [string, ...string[]];
  const container =
    value === undefined ? (head === "-" || /^(0|[1-9][0-9]*)$/.test(head) ? [] : {}) : value;
  const here = [...at, head];
  if (Array.isArray(container)) {
    const copy = [...container];
    if (head === "-") {
      if (rest.length > 0) throw new PlacementError(`${pointerText(here)} appends, so nothing can be written beneath it`);
      copy.push(placed);
      return copy;
    }
    if (!/^(0|[1-9][0-9]*)$/.test(head) || Number(head) > copy.length) {
      throw new PlacementError(`${pointerText(here)} is not a position of the list there`);
    }
    const index = Number(head);
    if (rest.length === 0) copy.splice(index, 0, placed);
    else copy[index] = added(copy[index], rest, placed, here);
    return copy;
  }
  if (!isMigrationMap(container)) {
    throw new PlacementError(`${pointerText(at)} holds ${isOpaqueMigrationValue(container) ? "a tagged value" : "a value that is not a map"}, so nothing can be written beneath it`);
  }
  return { ...container, [head]: added(container[head], rest, placed, here) };
}

class PlacementError extends Error {}

/** `base` with `patch` merged over it, each `kind:` spelled. */
function merged(base: unknown, patch: Record<string, unknown>, at: Segments, spell: (written: string) => KindSpelling): unknown {
  if (base !== undefined && !isMigrationMap(base)) {
    throw new PlacementError(`\`set:\` merges a map into ${pointerText(at)}, which holds ${isOpaqueMigrationValue(base) ? "a tagged value" : "a value that is not a map"}`);
  }
  const out: Record<string, unknown> = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "kind" && typeof value === "string") {
      const spelled = spell(value);
      if ("failure" in spelled) throw new PlacementError(spelled.failure);
      out[key] = spelled.kind;
    } else if (isMigrationMap(value)) {
      out[key] = merged(out[key], value, [...at, key], spell);
    } else {
      out[key] = cloneMigrationTree(value);
    }
  }
  return out;
}

const startsWith = (path: Segments, prefix: Segments) =>
  prefix.length <= path.length && prefix.every((segment, i) => path[i] === segment);

/** Applies `rule` to `node`, the matched node as found. */
export function applyMigrationRule(
  node: unknown,
  rule: MigrationRule,
  spell: (written: string) => KindSpelling,
  bindings: ReadonlyMap<string, BindingReading> = new Map(),
): RuleApplication {
  const removed = [...rule.remove, ...rule.move.map((m) => m.from.pointer)].map(migrationPointerSegments);
  const placements: { from: Segments; to: Segments; value: unknown }[] = [];
  for (const [placement, isCopy] of [
    ...rule.move.map((p) => [p, false] as const),
    ...rule.copy.map((p) => [p, true] as const),
  ]) {
    const from = migrationPointerSegments(placement.from.pointer);
    let source: ReturnType<typeof read>;
    if (placement.from.binding !== undefined) {
      const binding = bindings.get(placement.from.binding);
      if (!binding || !isCopy) return { failure: `the source ${placement.from.written} reads no binding of the rule` };
      if ("unreadable" in binding) return { failure: `copying ${placement.from.written} ${binding.unreadable}` };
      source = read(binding.value, from);
      if ("opaque" in source) {
        return { failure: `copying ${placement.from.written} reads into the tagged value at ${placement.from.binding}#${pointerText(source.opaque)}` };
      }
    } else {
      source = read(node, from);
      if ("opaque" in source) {
        return { failure: `${isCopy ? "copying" : "moving"} ${pointerText(from)} reads into the tagged value at ${pointerText(source.opaque)}` };
      }
    }
    if (source.found === undefined) continue;
    placements.push({ from, to: migrationPointerSegments(placement.to), value: isCopy ? cloneMigrationTree(source.found) : source.found });
  }

  for (let i = 0; i < placements.length; i++) {
    const { to } = placements[i]!;
    for (let j = 0; j < i; j++) {
      const other = placements[j]!.to;
      if (startsWith(to, other) || startsWith(other, to)) {
        return { failure: `two writes reach ${pointerText(to.length <= other.length ? to : other)}` };
      }
    }
    if (to[to.length - 1] !== "-" && !removed.some((r) => startsWith(to, r))) {
      const held = read(node, to);
      if ("found" in held && held.found !== undefined) {
        return { failure: `it writes ${pointerText(to)}, which the node already holds` };
      }
    }
    if (rule.set !== undefined) {
      const setHeld = read(rule.set, to);
      if ("found" in setHeld && setHeld.found !== undefined && !isMigrationMap(setHeld.found)) {
        return { failure: `two writes reach ${pointerText(to)}` };
      }
    }
  }

  try {
    let value: unknown = node;
    for (const segments of inRemovalOrder(removed)) value = without(value, segments);
    if (rule.set !== undefined) value = merged(value, rule.set, [], spell);
    for (const placement of placements) value = added(value, placement.to, placement.value);
    return { value };
  } catch (error) {
    if (error instanceof PlacementError) return { failure: error.message };
    throw error;
  }
}
