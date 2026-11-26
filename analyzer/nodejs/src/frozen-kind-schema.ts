/**
 * A kind's canonical schema as the registry holds it: one deep copy, built when
 * the kind is registered and frozen, which every reader of the kind's schema —
 * the analysis's passes, the eval-site walk, the kernel — reads instead of a
 * copy of its own. Nothing writes to it; a step that would (a hoisted `$defs`,
 * a merged parent) builds a new copy. Because a frozen copy cannot change, a
 * walk over it may be remembered by its identity (`eval-paths.ts`).
 *
 * Each copied node keeps the place and the authored `$ref` of the node it was
 * copied from. A tagged value (`!cel`, `!ref`, a compiled sentinel) is held as
 * it is: it is a value, not schema, and a compiler may annotate it.
 *
 * Browser-safe.
 */
import { isRefSentinel, isTaggedSentinel } from "@telorun/templating";
import { carryAuthoredSchemaRef } from "./authored-schema-refs.js";
import { inheritSchemaPlace } from "./schema-provenance.js";

/** Every node a frozen copy holds: a node found here is shared, not copied. */
const frozenNodes = new WeakSet<object>();

/** A deep copy of `schema`, frozen; a node already frozen by a copy is shared. */
export function frozenSchemaCopy<T>(schema: T): T {
  return copyOf(schema) as T;
}

/** Whether `schema` is a frozen copy, so nothing beneath it can change. */
export function isFrozenSchema(schema: unknown): boolean {
  return schema !== null && typeof schema === "object" && frozenNodes.has(schema);
}

const refSentinelHeld = new WeakMap<object, boolean>();

/** Whether a frozen copy holds a `!ref` at any depth — a reader turning each
 *  into its `$ref` needs a copy of its own only then. */
export function frozenSchemaHoldsRef(schema: object): boolean {
  let held = refSentinelHeld.get(schema);
  if (held === undefined) refSentinelHeld.set(schema, (held = holdsRef(schema)));
  return held;
}

function holdsRef(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (isRefSentinel(value)) return true;
  if (isTaggedSentinel(value)) return false;
  return (Array.isArray(value) ? value : Object.values(value)).some(holdsRef);
}

function copyOf(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (frozenNodes.has(value)) return value;
  if (isTaggedSentinel(value) || (value as { __compiled?: unknown }).__compiled) return value;
  let out: unknown[] | Record<string, unknown>;
  if (Array.isArray(value)) {
    out = value.map(copyOf);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    const record: Record<string, unknown> = {};
    for (const key of Object.keys(value)) record[key] = copyOf((value as Record<string, unknown>)[key]);
    out = record;
  }
  inheritSchemaPlace(out, value);
  carryAuthoredSchemaRef(value, out);
  Object.freeze(out);
  frozenNodes.add(out);
  return out;
}

/** The frozen schema the registry holds for the kind `kind` declares, for a
 *  reader that reads each `!ref` as its `$ref`: undefined when the registry
 *  holds none for `kind`, or when it holds a `!ref` that reader rewrites. */
export function frozenWalkSchema(
  defs: { registeredSchemaOf(kind: { metadata?: unknown }): Record<string, any> | undefined },
  kind: { metadata?: unknown },
): Record<string, any> | undefined {
  const schema = defs.registeredSchemaOf(kind);
  return schema && !frozenSchemaHoldsRef(schema) ? schema : undefined;
}
