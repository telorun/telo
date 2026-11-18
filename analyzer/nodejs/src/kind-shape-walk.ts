/**
 * A kind document's schema walk over every configuration at once, for a
 * verdict that walks into the named shapes the schema references.
 *
 * The walk never reads a named shape it reaches through a reference: it stops
 * there and names the reference (an edge). Each class of each shape reached is
 * walked once per pointer into it (`NamedShapeReader.verdict`), stopping at its
 * own named references the same way, and the walks are joined to the kind by
 * the reach fixpoint over the edges each walk met (`reachBeneath`) — so a
 * chain of shapes varying under choices costs one walk per class, and what a
 * walk finds inside a shape holds where its class is reached.
 *
 * A verdict that reads a shape it names directly — whether the node a
 * reference names is a text, which fields an object it names declares — reads
 * it through the lookup, split by that shape's classes (`splitByReads`).
 *
 * Browser-safe.
 */
import { propertySchemas } from "./manifest-navigation.js";
import { followSchemaReferences, schemaReferenceParts } from "./schema-reference.js";
import { nodeAtPointer, type NamedShapeReader, type ShapeClass, type ShapeEdge } from "./named-shape-reader.js";
import { FALSE, type Condition } from "./presence-condition.js";
import { splitByReads, type WorldReader } from "./world-reader.js";

type Schema = Record<string, any>;

/** What a walk reads of the schemas references name. */
export interface ShapeAccess {
  /** Whether `ref` names a named shape: the walk stops there. */
  stops(ref: string): boolean;
  /** The document an id names, read for a verdict of the walk's own: a
   *  named shape's content where the reading is, a kind's schema always. */
  lookup(id: string): Schema | undefined;
}

/** What one walk found, and the named-shape references it stopped at. */
export interface ShapeWalk<E> {
  readonly entries: readonly E[];
  readonly edges: readonly ShapeEdge[];
}

/** One part of a walk: where it holds, and what it found there. */
export interface ShapeWalkPart<V> {
  readonly condition: Condition;
  readonly walk: V;
}

/** The edge a named-shape reference `ref` is. */
export function shapeEdgeOf(ref: string): ShapeEdge {
  const { shape, pointer } = schemaReferenceParts(ref);
  return { ref, target: shape ?? ref, pointer };
}

/** The access of a walk where `read` reads. */
function accessAt(shapes: NamedShapeReader, kindSchemaOf: (id: string) => Schema | undefined, read: WorldReader<Condition>): ShapeAccess {
  return {
    stops: (ref) => {
      const { shape } = schemaReferenceParts(ref);
      return shape !== undefined && shapes.isShapeId(shape);
    },
    lookup: (id) => (shapes.isShapeId(id) ? shapes.classAt(id, read)?.schema : kindSchemaOf(id)),
  };
}

/** `walk`, split by the named shapes it reads directly, within `at`. */
export function walkParts<V>(
  shapes: NamedShapeReader,
  kindSchemaOf: (id: string) => Schema | undefined,
  walk: (access: ShapeAccess) => V,
  at: Condition = shapes.source.universe,
): ShapeWalkPart<V>[] {
  return splitByReads(shapes.space, at, (read) => walk(accessAt(shapes, kindSchemaOf, read))).map((part) => ({
    condition: part.condition,
    walk: part.value,
  }));
}

/** A reference the kind's own walk stopped at, and where in the kind. */
export interface ShapeRoot<W> {
  readonly where: W;
  readonly edge: ShapeEdge;
}

/** Something a walk found inside a shape, where in the kind it is reported,
 *  and where it holds. */
export interface HeldEntry<W, E> {
  readonly where: W;
  readonly entry: E;
  readonly shape: ShapeClass;
  readonly held: Condition;
}

export interface ShapeWalkVerdict<E> {
  /** Names the verdict, for its memo. */
  readonly name: string;
  readonly kindSchemaOf: (id: string) => Schema | undefined;
  /** The walk from `node`, the node `pointer` names in a class of `shape`. */
  walk(shape: ShapeClass, node: Schema, pointer: string, access: ShapeAccess): ShapeWalk<E>;
  /** What makes two findings one, within a class. */
  identity(entry: E): string;
}

/** One class's walk from `pointer`, split by what it reads directly, once. */
export function classWalkParts<E>(shapes: NamedShapeReader, verdict: ShapeWalkVerdict<E>, shape: ShapeClass, pointer: string): ShapeWalkPart<ShapeWalk<E>>[] {
  return shapes.verdict(`${verdict.name}${pointer}`, shape, () => {
    const node = nodeAtPointer(shape.schema, pointer);
    if (!node || typeof node !== "object" || Array.isArray(node)) return [];
    return walkParts(shapes, verdict.kindSchemaOf, (access) => verdict.walk(shape, node as Schema, pointer, access));
  });
}

/** The edges a class's walk from `pointer` meets, in any of its parts. */
function classEdges<E>(shapes: NamedShapeReader, verdict: ShapeWalkVerdict<E>, shape: ShapeClass, pointer: string): ShapeEdge[] {
  const out = new Map<string, ShapeEdge>();
  for (const part of classWalkParts(shapes, verdict, shape, pointer)) for (const edge of part.walk.edges) out.set(edge.ref, edge);
  return [...out.values()];
}

/** The pairs the walk reaches from `roots`, at each class's own edges. */
export function walkReach<E>(shapes: NamedShapeReader, verdict: ShapeWalkVerdict<E>, roots: readonly ShapeEdge[], at?: Condition) {
  return shapes.reachBeneath(roots, (shape, pointer) => classEdges(shapes, verdict, shape, pointer), at);
}

/**
 * What the walks of every shape reached from `roots` find, each reported at
 * the root it is reached from and held where its class is reached and its
 * part holds. A finding two roots reach is the first root's where both reach
 * it, as one walk in written order reports it once.
 */
export function entriesThroughShapes<W, E>(
  shapes: NamedShapeReader,
  verdict: ShapeWalkVerdict<E>,
  roots: readonly ShapeRoot<W>[],
  at?: Condition,
): HeldEntry<W, E>[] {
  const { space } = shapes;
  const covered = new Map<string, Condition>();
  const out = new Map<string, { where: W; entry: E; shape: ShapeClass; held: Condition }>();
  roots.forEach((root, index) => {
    const reached = new Map<string, Condition>();
    for (const pair of walkReach(shapes, verdict, [root.edge], at)) {
      for (const shape of shapes.classes(pair.target)) {
        const base = space.and(pair.condition, shape.condition);
        if (base === FALSE) continue;
        for (const part of classWalkParts(shapes, verdict, shape, pair.pointer)) {
          const held = space.and(base, part.condition);
          if (held === FALSE) continue;
          for (const entry of part.walk.entries) {
            const id = JSON.stringify([shape.id, shape.index, verdict.identity(entry)]);
            reached.set(id, space.or(reached.get(id) ?? FALSE, held));
            if (!out.has(`${index}\0${id}`)) out.set(`${index}\0${id}`, { where: root.where, entry, shape, held: FALSE });
          }
        }
      }
    }
    for (const [id, held] of reached) {
      const prior = covered.get(id) ?? FALSE;
      out.get(`${index}\0${id}`)!.held = space.and(held, space.not(prior));
      covered.set(id, space.or(prior, held));
    }
  });
  return [...out.values()].filter((found) => found.held !== FALSE);
}

/** Where a path ends, and where it ends there: undefined where it names nothing. */
export interface PathEnd {
  readonly node: Schema | undefined;
  readonly held: Condition;
}

/** A path continued inside a named shape: the reference it went through and
 *  the property names still to follow. */
interface PathAt {
  readonly ref: string;
  readonly target: string;
  readonly pointer: string;
  readonly rest: readonly string[];
}

type PathStep = { readonly end: Schema | undefined } | { readonly into: PathAt };

const isSchemaNode = (value: unknown): value is Schema => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * The nodes following the property names `segments` from `node` (written in
 * `document`) ends at, every reference on the way followed — a document-local
 * pointer and a kind's schema in place, a named shape through the reader: the
 * walk stops at a reference to one, each class of the shape continues it once
 * per place and path left (`NamedShapeReader.verdict`), and the continuations
 * are joined by the reach fixpoint, so a chain of shapes costs one step per
 * class. An end inside a shape holds where its class is reached; a shape no
 * configuration declares ends nowhere.
 */
export function pathEnds(
  shapes: NamedShapeReader,
  kindSchemaOf: (id: string) => Schema | undefined,
  node: Schema,
  document: Schema | undefined,
  segments: readonly string[],
  at: Condition,
): PathEnd[] {
  const { space } = shapes;
  const lookup = (id: string) => (shapes.isShapeId(id) ? undefined : kindSchemaOf(id));
  const step = (from: Schema, within: Schema | undefined, path: readonly string[]): PathStep => {
    let current = from;
    let doc = within;
    let rest = path;
    for (;;) {
      const followed = followSchemaReferences(current, doc, lookup);
      current = followed.node;
      doc = followed.document;
      if (typeof current.$ref === "string") {
        const { shape, pointer } = schemaReferenceParts(current.$ref);
        if (shape !== undefined && shapes.isShapeId(shape)) return { into: { ref: current.$ref, target: shape, pointer, rest } };
      }
      if (rest.length === 0) return { end: current };
      const next = propertySchemas(current).find(([key]) => key === rest[0])?.[1];
      if (!isSchemaNode(next)) return { end: undefined };
      current = next;
      rest = rest.slice(1);
    }
  };
  const classStep = (shape: ShapeClass, place: PathAt): PathStep =>
    shapes.verdict(`pathStep${place.pointer}\0${JSON.stringify(place.rest)}`, shape, () => {
      const inner = nodeAtPointer(shape.schema, place.pointer);
      // A pointer naming nothing leaves the reference itself, as a reference
      // that resolves to nothing does.
      if (!isSchemaNode(inner)) return { end: place.rest.length === 0 ? { $ref: place.ref } : undefined };
      return step(inner, shape.schema, place.rest);
    });

  const first = step(node, document, segments);
  if ("end" in first) return at === FALSE ? [] : [{ node: first.end, held: at }];
  const reached = shapes.reachOver(
    [{ node: first.into, condition: at }],
    (place) =>
      shapes.classes(place.target).flatMap((shape) => {
        const next = classStep(shape, place);
        return "into" in next ? [{ node: next.into, condition: shape.condition }] : [];
      }),
    (place) => JSON.stringify([place.target, place.pointer, place.rest]),
  );
  const out: PathEnd[] = [];
  for (const { node: place, condition } of reached.values()) {
    for (const shape of shapes.classes(place.target)) {
      const next = classStep(shape, place);
      if (!("end" in next)) continue;
      const held = space.and(condition, shape.condition);
      if (held !== FALSE) out.push({ node: next.end, held });
    }
  }
  return out;
}
