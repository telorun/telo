/**
 * The one reader of named shapes over every configuration at once.
 *
 * A named shape (a `Telo.Type` declaration, `telo:<module>/<Name>`) may be
 * declared only under a choice and may hold choices in its own content, so
 * what it is differs between configurations. The reader answers it as CLASSES:
 * each distinct content the shape takes, with its `extends` parents folded as
 * the registry folds them, and the condition it holds under — read once per
 * shape by splitting on the choices its content and its fold read
 * (`splitByReads`). A shape with more than one class, or absent from some
 * configuration, varies.
 *
 * Every verdict reading a shape's content goes through it:
 *
 *  - a verdict over a kind document reads the named shapes it reaches as
 *    STAND-INS — documents that always compile and say nothing — and names the
 *    references it met;
 *  - each shape class gets its own sub-verdict once, its own named references
 *    stood in the same way, memoised per (shape, class);
 *  - the two are joined by the REACH graph: an edge from each reference a
 *    document writes to the shape it names, labelled by the class holding it,
 *    reach conditions computed by a fixpoint, linear in edges.
 *
 * A finding about a reference pair — the document writing a reference and the
 * shape it names — holds where the pair is reached and the sub-verdict fails.
 *
 * Browser-safe.
 */
import type { ResourceManifest } from "@telorun/sdk";
import { canonicalTypeSchemaId, parseCanonicalTypeSchemaId } from "@telorun/sdk";
import type { ChoiceDecider } from "./conditioned-expansion.js";
import { configuredNamedShapes, type ConfiguredShapeScope } from "./configured-named-shapes.js";
import { foldedNamedShapeReads, type NamedShapeDeclaration } from "./named-shape-extends.js";
import { FALSE, TRUE, type Condition, type ConditionSpace } from "./presence-condition.js";
import { schemaReferenceParts } from "./schema-reference.js";
import { splitByReads, type WorldReader } from "./world-reader.js";

type Schema = Record<string, any>;

/** One declaration of a named shape, and where it holds. */
export interface NamedShapeDeclarationAt {
  readonly manifest: ResourceManifest;
  readonly condition: Condition;
  /** The declaration as `read` decides its choices. */
  project(read: ChoiceDecider): ResourceManifest | undefined;
}

/** What the reader is built over: the declarations of one analysis. */
export interface NamedShapeSource {
  readonly space: ConditionSpace;
  /** The configurations kept. */
  readonly universe: Condition;
  readonly declarations: readonly NamedShapeDeclarationAt[];
  readonly scope: ConfiguredShapeScope;
  /** Each imported library's own shapes, the same in every configuration. */
  readonly libraries: readonly NamedShapeDeclaration[];
}

/** One content a shape takes, and where. */
export interface ShapeClass {
  readonly id: string;
  readonly index: number;
  readonly condition: Condition;
  /** Canonical in its module, its `extends` parents folded. */
  readonly schema: Schema;
}

/** A reference to a named shape a document writes. */
export interface ShapeEdge {
  /** The reference as written there, canonical. */
  readonly ref: string;
  readonly target: string;
  /** `#`, or the pointer into the target. */
  readonly pointer: string;
}

/** A reference pair a reach holds: the shape writing the reference (none: the
 *  root), the reference, and where the pair is reached. */
export interface ShapePair extends ShapeEdge {
  readonly writer: string | undefined;
  readonly condition: Condition;
}

/** What kind of sub-verdict a shape class was judged for. */
export type ShapeVerdictKind = string;

let verdictObserver: ((kind: ShapeVerdictKind, id: string, index: number) => void) | undefined;

/** Observe every sub-verdict a named-shape reader computes until the returned
 *  function is called. */
export function observeShapeVerdicts(listener: (kind: ShapeVerdictKind, id: string, index: number) => void): () => void {
  verdictObserver = listener;
  return () => {
    if (verdictObserver === listener) verdictObserver = undefined;
  };
}

const isObject = (value: unknown): value is Schema => !!value && typeof value === "object" && !Array.isArray(value);

/** The decoded segments of a JSON Pointer fragment (`#/a/b~1c`). */
function pointerSegments(pointer: string): string[] {
  const body = pointer.replace(/^#/, "");
  if (body === "" || body === "/") return [];
  return body
    .split("/")
    .slice(1)
    .map((segment) => decodeURIComponent(segment).replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** The node a pointer names in `document`, or undefined. */
export function nodeAtPointer(document: unknown, pointer: string): unknown {
  let node = document;
  for (const segment of pointerSegments(pointer)) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

export class NamedShapeReader {
  private readonly classMemo = new Map<string, readonly ShapeClass[]>();
  private readonly edgeMemo = new WeakMap<object, readonly ShapeEdge[]>();
  private readonly verdictMemo = new Map<string, unknown>();
  private readonly reads: (module: string, name: string) => ReadonlySet<string>;
  private readonly byId = new Map<string, NamedShapeDeclarationAt[]>();
  private readonly libraryIds: ReadonlySet<string>;

  constructor(readonly source: NamedShapeSource) {
    const declared: NamedShapeDeclaration[] = [];
    for (const declaration of source.declarations) {
      const m = declaration.manifest;
      const module = (m.metadata as { module?: unknown } | undefined)?.module;
      const name = m.metadata?.name;
      if (typeof module !== "string" || typeof name !== "string") continue;
      const id = canonicalTypeSchemaId(module, name);
      const list = this.byId.get(id) ?? [];
      list.push(declaration);
      this.byId.set(id, list);
      declared.push({ module, name, schema: {}, extends: (m as { extends?: unknown }).extends });
    }
    for (const library of source.libraries) declared.push({ ...library, schema: {} });
    this.libraryIds = new Set(source.libraries.map((library) => canonicalTypeSchemaId(library.module, library.name)));
    this.reads = foldedNamedShapeReads(declared);
  }

  get space(): ConditionSpace {
    return this.source.space;
  }

  /** Whether `id` names a named shape rather than a kind's schema. */
  isShapeId(id: string): boolean {
    return parseCanonicalTypeSchemaId(id) !== null && !this.source.scope.defs.claimsSchemaId(id);
  }

  /** Every named-shape id some declaration or library declares. */
  declaredIds(): string[] {
    return [...new Set([...this.byId.keys(), ...this.libraryIds])];
  }

  /** The classes of `id`: none where nothing declares it. */
  classes(id: string): readonly ShapeClass[] {
    const known = this.classMemo.get(id);
    if (known) return known;
    const named = parseCanonicalTypeSchemaId(id);
    let classes: ShapeClass[] = [];
    if (named && this.isShapeId(id)) {
      const chain = this.reads(named.moduleName, named.typeName);
      const relevant = [...chain].flatMap((each) => this.byId.get(each) ?? []);
      const { space, universe, scope, libraries } = this.source;
      const parts = splitByReads(space, universe, (read) => {
        const present: ResourceManifest[] = [];
        for (const declaration of relevant) {
          if (!read.holds(declaration.condition)) continue;
          const projected = declaration.project(read);
          if (projected) present.push(projected);
        }
        return configuredNamedShapes(present, scope, libraries)(named.moduleName, named.typeName);
      });
      const byText = new Map<string, { condition: Condition; schema: Schema }>();
      for (const part of parts) {
        if (!part.value) continue;
        const text = JSON.stringify(part.value);
        const known = byText.get(text);
        if (known) known.condition = space.or(known.condition, part.condition);
        else byText.set(text, { condition: part.condition, schema: part.value });
      }
      classes = [...byText.values()].map((each, index) => ({ id, index, condition: each.condition, schema: each.schema }));
    }
    this.classMemo.set(id, classes);
    return classes;
  }

  /** The declarations of `id`, as written. */
  declarationsOf(id: string): readonly NamedShapeDeclarationAt[] {
    return this.byId.get(id) ?? [];
  }

  /** Where `id` is declared. */
  presence(id: string): Condition {
    return this.space.some(this.classes(id).map((each) => each.condition));
  }

  /** Whether `id` differs between configurations: more than one class, or
   *  absent from some. */
  varies(id: string): boolean {
    const classes = this.classes(id);
    if (classes.length > 1) return true;
    return classes.length === 1 && classes[0]!.condition !== this.source.universe && classes[0]!.condition !== TRUE;
  }

  /** The class of `id` `read` takes, asking only the conditions on the way. */
  classAt(id: string, read: WorldReader<Condition>): ShapeClass | undefined {
    for (const each of this.classes(id)) if (read.holds(each.condition)) return each;
    return undefined;
  }

  /** The named-shape references `document` writes, in written order. */
  edges(document: Schema): readonly ShapeEdge[] {
    const known = this.edgeMemo.get(document);
    if (known) return known;
    const out: ShapeEdge[] = [];
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
        return;
      }
      if (!isObject(node)) return;
      if (typeof node.$ref === "string") {
        const { shape, pointer } = schemaReferenceParts(node.$ref);
        if (shape !== undefined && this.isShapeId(shape)) out.push({ ref: node.$ref, target: shape, pointer });
      }
      for (const [key, child] of Object.entries(node)) if (key !== "$ref") visit(child);
    };
    visit(document);
    this.edgeMemo.set(document, out);
    return out;
  }

  /**
   * Every reference pair reached from `roots` — references a root document
   * writes — through the classes of the shapes they name, each with the
   * condition it is reached under: a fixpoint over the edges, each visited
   * again only when its reach grows. A class's edges are every reference its
   * content writes.
   */
  reach(roots: readonly ShapeEdge[], at: Condition = this.source.universe): ShapePair[] {
    return this.fixpoint(roots, at, (shape) => this.edges(shape.schema), (edge) => edge.target);
  }

  /**
   * The same fixpoint for a verdict that reads a shape from where a reference
   * points into it: a class's edges at a pointer are those `edgesOf` says the
   * verdict meets beneath the node there, so a pair is reached at its pointer.
   */
  reachBeneath(
    roots: readonly ShapeEdge[],
    edgesOf: (shape: ShapeClass, pointer: string) => readonly ShapeEdge[],
    at: Condition = this.source.universe,
  ): ShapePair[] {
    return this.fixpoint(roots, at, edgesOf, (edge) => JSON.stringify([edge.target, edge.pointer]));
  }

  private fixpoint(
    roots: readonly ShapeEdge[],
    at: Condition,
    edgesOf: (shape: ShapeClass, pointer: string) => readonly ShapeEdge[],
    nodeOf: (edge: ShapeEdge) => string,
  ): ShapePair[] {
    const { space } = this;
    const pairs = new Map<string, { pair: ShapeEdge; writer: string | undefined; condition: Condition }>();
    const record = (writer: string | undefined, edge: ShapeEdge, condition: Condition): void => {
      const key = JSON.stringify([writer ?? null, edge.ref]);
      const known = pairs.get(key);
      if (known) known.condition = space.or(known.condition, condition);
      else pairs.set(key, { pair: edge, writer, condition });
    };
    for (const edge of roots) if (at !== FALSE) record(undefined, edge, at);
    this.reachOver(
      roots.map((edge) => ({ node: edge, condition: at })),
      (into) =>
        this.classes(into.target).flatMap((each) =>
          edgesOf(each, into.pointer).map((edge) => ({ node: edge, condition: each.condition })),
        ),
      nodeOf,
      (from, to, condition) => record(from.target, to, condition),
    );
    return [...pairs.values()].map(({ pair, writer, condition }) => ({ ...pair, writer, condition }));
  }

  /**
   * THE reach fixpoint every verdict joining named shapes shares: the least
   * fixpoint of where each node is reached from `roots`, a successor reached
   * where its node is and its edge's condition holds, each node visited again
   * only when its reach grows — linear in edges. `onEdge` sees every edge
   * taken, with the condition it is taken under.
   */
  reachOver<N>(
    roots: readonly { readonly node: N; readonly condition: Condition }[],
    successors: (node: N) => Iterable<{ readonly node: N; readonly condition: Condition }>,
    identity: (node: N) => string,
    onEdge?: (from: N, to: N, condition: Condition) => void,
  ): Map<string, { node: N; condition: Condition }> {
    const { space } = this;
    const reached = new Map<string, { node: N; condition: Condition }>();
    const pending: string[] = [];
    const add = (node: N, condition: Condition): void => {
      if (condition === FALSE) return;
      const key = identity(node);
      const before = reached.get(key)?.condition ?? FALSE;
      const after = space.or(before, condition);
      if (after === before) return;
      reached.set(key, { node: reached.get(key)?.node ?? node, condition: after });
      pending.push(key);
    };
    for (const root of roots) add(root.node, root.condition);
    while (pending.length > 0) {
      const { node, condition } = reached.get(pending.pop()!)!;
      for (const next of successors(node)) {
        const held = space.and(condition, next.condition);
        if (held === FALSE) continue;
        onEdge?.(node, next.node, held);
        add(next.node, held);
      }
    }
    return reached;
  }

  /** The stand-in of every named shape a document may reference: a document
   *  that always compiles and says nothing, holding each pointer path `roots`
   *  and the shapes' own classes name into it, an empty schema at each. */
  standIns(roots: Iterable<readonly ShapeEdge[]>): Map<string, Schema> {
    const out = new Map<string, Schema>();
    const hold = (edge: ShapeEdge): void => {
      let document = out.get(edge.target);
      if (!document) out.set(edge.target, (document = {}));
      // A numeric segment indexes a list (`anyOf/0`), every other one a map.
      let node: any = document;
      const segments = pointerSegments(edge.pointer);
      segments.forEach((segment, i) => {
        const list = /^\d+$/.test(segments[i + 1] ?? "");
        if (Array.isArray(node)) {
          const index = Number(segment);
          while (node.length <= index) node.push({});
          if (list && !Array.isArray(node[index])) node[index] = [];
          node = node[index];
          return;
        }
        if (list ? !Array.isArray(node[segment]) : !isObject(node[segment])) node[segment] = list ? [] : {};
        node = node[segment];
      });
    };
    for (const id of this.declaredIds()) if (!out.has(id)) out.set(id, {});
    for (const list of roots) for (const edge of list) hold(edge);
    for (const id of this.declaredIds()) for (const each of this.classes(id)) for (const edge of this.edges(each.schema)) hold(edge);
    return out;
  }

  /** `compute` over one class of a shape, once per `kind` and class. */
  verdict<V>(kind: ShapeVerdictKind, shape: ShapeClass, compute: () => V): V {
    const key = JSON.stringify([kind, shape.id, shape.index]);
    if (this.verdictMemo.has(key)) return this.verdictMemo.get(key) as V;
    verdictObserver?.(kind, shape.id, shape.index);
    const value = compute();
    this.verdictMemo.set(key, value);
    return value;
  }

  /** `compute` over one pair of classes, once per `kind` and pair. */
  pairVerdict<V>(kind: ShapeVerdictKind, key: string, compute: () => V): V {
    const memo = JSON.stringify([kind, key]);
    if (this.verdictMemo.has(memo)) return this.verdictMemo.get(memo) as V;
    verdictObserver?.(kind, key, -1);
    const value = compute();
    this.verdictMemo.set(memo, value);
    return value;
  }
}

/** The reader of a world with no choices: a condition holds where it is not FALSE. */
export const PLAIN_READER: WorldReader<Condition> = {
  holds: (held) => held !== FALSE,
  taken: (element) => element.condition !== FALSE,
};
