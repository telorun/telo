/**
 * Where each schema node the analyzer hands the CEL engine was written: its
 * provenance, read by the `CEL_SCHEMA_UNJUDGED` placement.
 *
 * Every document the analysis receives records each of its nodes at its path
 * there, in the position index's own grammar (`a.b[0].c`), so a finding placed
 * there is ranged by that index (`recordDocumentPlaces`, at registration and
 * at the analysis's entry; a node already recorded keeps its first place). A
 * node a composer builds from another — inline normalization's clone, the
 * registration door's copy, a resolved `!ref`, a nullable signature — carries
 * the place of the node it came from, recorded by the composer; a node of
 * Telo's own vocabulary (a built-in kind, a fragment's expansion) is
 * {@link BUILT_IN}. Placement is one lookup per node, walking no document.
 *
 * Browser-safe.
 */
import type { ResourceManifest } from "@telorun/sdk";

/** A node of Telo's built-in vocabulary, written in no module. */
export const BUILT_IN = "built-in" as const;

/** The written node a schema node came from: the document holding it, read
 *  when a finding is placed (the loader stamps its metadata after parsing),
 *  and its path there. */
export interface WrittenSchemaPlace {
  readonly manifest: ResourceManifest;
  readonly keys: readonly (string | number)[];
}

/** `keys` in the position index's grammar: `a.b[0].c`. */
export function placePath(keys: readonly (string | number)[]): string {
  let path = "";
  for (const key of keys) path = typeof key === "number" ? `${path}[${key}]` : path === "" ? key : `${path}.${key}`;
  return path;
}

export type SchemaPlace = WrittenSchemaPlace | typeof BUILT_IN;

const places = new WeakMap<object, SchemaPlace>();

let lookups = 0;

/** Where `node` was written, or undefined where nothing recorded it. */
export function schemaPlaceOf(node: object): SchemaPlace | undefined {
  lookups++;
  return places.get(node);
}

/** The loaded document `copy` is a copy of — the document whose root its own
 *  place is — or undefined. Not a placement, so not counted. */
export function sourceDocumentOf(copy: object): ResourceManifest | undefined {
  const place = places.get(copy);
  return place && place !== BUILT_IN && place.keys.length === 0 ? place.manifest : undefined;
}

/** How many provenance lookups were made, for a cost counter. */
export function schemaPlaceLookups(): number {
  return lookups;
}

const isObject = (value: unknown): value is object => value !== null && typeof value === "object";

/**
 * Record every node of a loaded document at its own path. A node already
 * recorded keeps its place: a value two documents share (a desugared import
 * holding its module document's `variables:`) is written where it was first
 * produced.
 */
export function recordDocumentPlaces(manifest: ResourceManifest): void {
  const visit = (value: unknown, keys: readonly (string | number)[]): void => {
    if (!isObject(value) || places.has(value)) return;
    places.set(value, { manifest, keys });
    if (Array.isArray(value)) value.forEach((child, index) => visit(child, [...keys, index]));
    else {
      for (const [key, child] of Object.entries(value)) {
        if (keys.length === 0 && key === "metadata") continue;
        visit(child, [...keys, key]);
      }
    }
  };
  visit(manifest, []);
}

/** `copy` was built from `source`: it carries `source`'s place. Children the
 *  copy shares with `source` keep their own. */
export function inheritSchemaPlace<T extends object>(copy: T, source: object): T {
  if (copy !== source && !places.has(copy)) {
    const place = places.get(source);
    if (place) places.set(copy, place);
  }
  return copy;
}

/**
 * `copy` was built from `source` by a composer that may have rebuilt any node
 * beneath it: each node of `copy` not yet recorded takes the place of the node
 * at the same position in `source`, and where `source` holds none, the place
 * beneath its nearest recorded ancestor at the same relative path.
 */
export function inheritSchemaPlaces(copy: unknown, source: unknown): void {
  const visit = (to: unknown, from: unknown, derived: SchemaPlace | undefined): void => {
    if (!isObject(to)) return;
    const place = places.get(to) ?? (isObject(from) ? places.get(from) : undefined) ?? derived;
    if (!place) return;
    if (!places.has(to)) places.set(to, place);
    if (to === from) return;
    const under = (segment: string | number): SchemaPlace =>
      place === BUILT_IN ? BUILT_IN : { manifest: place.manifest, keys: [...place.keys, segment] };
    if (Array.isArray(to)) {
      to.forEach((child, index) => visit(child, Array.isArray(from) ? from[index] : undefined, under(index)));
    } else {
      for (const [key, child] of Object.entries(to)) {
        const next = isObject(from) && !Array.isArray(from) ? (from as Record<string, unknown>)[key] : undefined;
        visit(child, next, under(key));
      }
    }
  };
  visit(copy, source, undefined);
}

/** Record every node of `schema` not yet recorded as Telo's own. */
export function recordBuiltInSchema(schema: unknown): void {
  const visit = (value: unknown): void => {
    if (!isObject(value) || places.has(value)) return;
    places.set(value, BUILT_IN);
    if (Array.isArray(value)) value.forEach(visit);
    else Object.values(value).forEach(visit);
  };
  visit(schema);
}
