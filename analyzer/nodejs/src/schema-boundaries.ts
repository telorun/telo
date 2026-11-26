/**
 * The boundary references a value meets as a schema is validated over it.
 *
 * A check reading a named shape reads only the shapes it names directly; a
 * reference written INSIDE a named shape to a shape `stops` answers for is a
 * boundary, never followed. This walk follows a schema over a value as a
 * validator applies it and lists each boundary it meets, with the data
 * position it applies at and whether a keyword relating members encloses it
 * (`anyOf`, `oneOf`, `not`, `if` / `then` / `else`, `dependentSchemas` /
 * `dependencies`, `contains`, tuple `items` / `prefixItems`) — a schema carve,
 * read by its verdict's summary there — or it stands at a member-wise
 * position, read as an empty stand-in beside its own sub-verdict.
 *
 * Browser-safe.
 */
import { isTaggedSentinel } from "@telorun/templating";
import { schemaPattern } from "@telorun/sdk";
import type { NamedShapeLookup } from "./schema-reference.js";
import { resolveSchemaReference, schemaReferenceParts } from "./schema-reference.js";

type Schema = Record<string, any>;
type Keys = readonly (string | number)[];

/** One boundary reference met at a data position. */
export interface SchemaBoundary {
  /** The canonical id of the shape it names. */
  readonly id: string;
  /** The reference as written. */
  readonly ref: string;
  readonly at: Keys;
  /** Whether a keyword relating members encloses it. */
  readonly carve: boolean;
  /** The innermost keyword relating members enclosing it, if any. */
  readonly relation?: string;
}

export interface SchemaBoundaryWalk {
  /** Answers each named shape a reference names. */
  readonly lookup: NamedShapeLookup;
  /** Whether a reference to `id`, written inside a named shape, is a boundary. */
  readonly stops: (id: string) => boolean;
  /** The schema an inline declaration beneath a field is judged against, which
   *  ends the walk there: it is a declaration of its own. */
  readonly declaration?: (value: Record<string, unknown>) => boolean;
  /** The region the walk serves: on the way to it one key, beneath it every
   *  child. None: every child. */
  readonly region?: Keys;
}

const isObject = (value: unknown): value is Schema => !!value && typeof value === "object" && !Array.isArray(value);

const valueAt = (data: unknown, keys: Keys): unknown => {
  let at = data;
  for (const key of keys) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<string | number, unknown>)[key];
  }
  return at;
};

/**
 * Every boundary `schema` — a node of `document`, which is a named shape's
 * document when `inShape` — meets over `data` at `at`, in written order.
 */
export function schemaBoundaries(
  data: unknown,
  at: Keys,
  schema: Schema,
  document: Schema,
  inShape: boolean,
  walk: SchemaBoundaryWalk,
): SchemaBoundary[] {
  const out: SchemaBoundary[] = [];
  const met = new Set<string>();
  const shapeDocuments = new WeakSet<object>();
  if (inShape) shapeDocuments.add(document);
  const region = walk.region;
  const visit = (node: unknown, place: Keys, doc: Schema, relation: string | undefined, seen: ReadonlySet<object>): void => {
    const carve = relation !== undefined;
    if (!isObject(node) || seen.has(node)) return;
    const guard = new Set(seen).add(node);
    const value = valueAt(data, place);
    if (typeof node.$ref === "string") {
      const ref = node.$ref as string;
      const { shape } = schemaReferenceParts(ref);
      if (shape !== undefined && shapeDocuments.has(doc) && walk.stops(shape)) {
        const text = JSON.stringify([shape, ref, place, carve]);
        if (!met.has(text)) {
          met.add(text);
          out.push({ id: shape, ref, at: place, carve, ...(relation ? { relation } : {}) });
        }
      } else {
        const target = resolveSchemaReference(ref, doc, walk.lookup);
        if (target) {
          if (target.shape !== undefined) shapeDocuments.add(target.document);
          visit(target.node, place, target.document, relation, guard);
        }
      }
    }
    if (Array.isArray(node.allOf)) for (const member of node.allOf) visit(member, place, doc, relation, guard);
    for (const keyword of ["anyOf", "oneOf"] as const) {
      if (Array.isArray(node[keyword])) for (const member of node[keyword]) visit(member, place, doc, keyword, guard);
    }
    for (const keyword of ["not", "if", "then", "else"] as const) visit(node[keyword], place, doc, keyword, guard);
    if (value === undefined || value === null || typeof value !== "object" || isTaggedSentinel(value)) return;
    if (!Array.isArray(value)) {
      for (const keyword of ["dependentSchemas", "dependencies"] as const) {
        const dependent = node[keyword];
        if (!isObject(dependent)) continue;
        for (const [key, member] of Object.entries(dependent)) {
          if (Object.hasOwn(value, key) && isObject(member)) visit(member, place, doc, keyword, guard);
        }
      }
    }
    // On the way to the region its one key; beneath it, every child.
    const onTheWay = region !== undefined && place.length < region.length;
    const children: [string | number, unknown][] = onTheWay
      ? [[region[place.length]!, valueAt(value, [region[place.length]!])]]
      : Array.isArray(value)
        ? value.map((item, i) => [i, item])
        : Object.entries(value as Record<string, unknown>);
    for (const [key, child] of children) {
      if (child === undefined) continue;
      const next = [...place, key];
      if (
        place.length > 0 &&
        isObject(child) &&
        typeof child.kind === "string" &&
        child.kind !== "Telo.Definition" &&
        walk.declaration?.(child)
      ) {
        continue;
      }
      if (typeof key === "number") {
        if (isObject(node.items)) visit(node.items, next, doc, relation, guard);
        if (Array.isArray(node.items)) visit(node.items[key], next, doc, "items", guard);
        if (Array.isArray(node.prefixItems)) visit(node.prefixItems[key], next, doc, "prefixItems", guard);
        if (Array.isArray(node.items) && key >= node.items.length) visit(node.additionalItems, next, doc, relation, guard);
        visit(node.contains, next, doc, "contains", guard);
        continue;
      }
      const properties = node.properties as Record<string, unknown> | undefined;
      let matched = false;
      if (properties && Object.hasOwn(properties, key)) {
        matched = true;
        visit(properties[key], next, doc, relation, guard);
      }
      for (const [pattern, member] of Object.entries((node.patternProperties ?? {}) as Record<string, unknown>)) {
        let test: { test(text: string): boolean };
        try {
          test = schemaPattern(pattern, "u");
        } catch {
          // A pattern RE2 cannot read is the schema check's to report.
          continue;
        }
        if (test.test(key)) {
          matched = true;
          visit(member, next, doc, relation, guard);
        }
      }
      if (!matched && isObject(node.additionalProperties)) visit(node.additionalProperties, next, doc, relation, guard);
    }
  };
  visit(schema, at, document, undefined, new Set());
  return out;
}
