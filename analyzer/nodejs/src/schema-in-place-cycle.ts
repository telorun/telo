/**
 * The one reader of the in-place cycle rule: a schema whose references come back
 * to the node they left at the same data position recurses without bound under
 * any validator, so it is refused where it is declared (`SCHEMA_IN_PLACE_CYCLE`)
 * and nothing is validated against it.
 *
 * A keyword is IN PLACE when it applies its subschema to the value its own node
 * applies to: `$ref`, `allOf`, `anyOf`, `oneOf`, `not`, `if` / `then` / `else`,
 * `dependencies` / `dependentSchemas`. Every other keyword holding a subschema
 * (`properties`, `items`, `contains`, …) descends into a part of the value, and
 * recursion through one is how a tree is written.
 *
 * The graph is over REFERENCE NODES — the schema nodes holding a `$ref` — since
 * every cycle crosses a reference: the in-place keywords alone only deepen a
 * document. A node's successors are the reference nodes met from the node its
 * reference names through in-place keywords alone.
 *
 * Browser-safe: the kernel's registration guards and the analysis read it.
 */
import { MANIFEST_SCHEMA_URI } from "./manifest-schemas.js";
import { schemaReferenceParts } from "./schema-reference.js";

export const SCHEMA_IN_PLACE_CYCLE = "SCHEMA_IN_PLACE_CYCLE";

/** The keywords a reference may recurse through, each descending into a part of
 *  the value. */
export const DESCENDING_KEYWORDS = [
  "properties",
  "patternProperties",
  "additionalProperties",
  "items",
  "additionalItems",
  "prefixItems",
  "contains",
] as const;

type Schema = Record<string, any>;

const isObject = (value: unknown): value is Schema => !!value && typeof value === "object" && !Array.isArray(value);

/** Keywords whose value is data, never a subschema. */
const DATA_KEYWORDS = new Set(["const", "enum", "default", "examples"]);

const escapeSegment = (segment: string): string => segment.replace(/~/g, "~0").replace(/\//g, "~1");

/** The segments of a JSON Pointer fragment, URI- and tilde-decoded. */
export function pointerSegments(pointer: string): string[] {
  return pointer
    .replace(/^#/, "")
    .split("/")
    .slice(1)
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // A segment that is not URI-encoded is read as written.
      }
      return decoded.replace(/~1/g, "/").replace(/~0/g, "~");
    });
}

/** A pointer in the one spelling every node of the graph is keyed by. */
export function canonicalPointer(pointer: string): string {
  const segments = pointerSegments(pointer);
  return segments.length === 0 ? "#" : `#/${segments.map(escapeSegment).join("/")}`;
}

/** The node `pointer` names in `document`, or undefined. */
export function nodeAt(document: unknown, pointer: string): unknown {
  let node = document;
  for (const segment of pointerSegments(pointer)) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** A `$ref` a document writes: the pointer of the node holding it, and the
 *  reference as written. */
export interface WrittenReference {
  readonly at: string;
  readonly ref: string;
}

/** Every reference `document` writes, at any keyword, in written order. */
export function writtenReferences(document: unknown): WrittenReference[] {
  const out: WrittenReference[] = [];
  const visit = (node: unknown, at: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${at}/${i}`));
      return;
    }
    if (!isObject(node)) return;
    if (typeof node.$ref === "string") out.push({ at, ref: node.$ref });
    for (const [key, child] of Object.entries(node)) {
      if (key === "$ref" || DATA_KEYWORDS.has(key)) continue;
      visit(child, `${at}/${escapeSegment(key)}`);
    }
  };
  visit(document, "#");
  return out;
}

/** The references met from the node at `pointer` of `document` through in-place
 *  keywords alone, the node's own included. */
export function inPlaceReferences(document: unknown, pointer: string): WrittenReference[] {
  const out: WrittenReference[] = [];
  const visit = (node: unknown, at: string): void => {
    if (!isObject(node)) return;
    if (typeof node.$ref === "string") out.push({ at, ref: node.$ref });
    for (const key of ["allOf", "anyOf", "oneOf"]) {
      const list = node[key];
      if (Array.isArray(list)) list.forEach((child, i) => visit(child, `${at}/${key}/${i}`));
    }
    for (const key of ["not", "if", "then", "else"]) visit(node[key], `${at}/${key}`);
    // `dependencies` holds a property list or a schema per key; only a schema applies.
    for (const key of ["dependentSchemas", "dependencies"]) {
      const map = node[key];
      if (isObject(map)) for (const [name, child] of Object.entries(map)) visit(child, `${at}/${key}/${escapeSegment(name)}`);
    }
  };
  const start = canonicalPointer(pointer);
  visit(nodeAt(document, start), start);
  return out;
}

/** Where a reference lands: a document and the pointer into it. */
export interface InPlaceTarget {
  readonly document: string;
  readonly pointer: string;
}

/** A reference as the graph reads it: `ref` at `at` of `document` names `target`. */
export interface InPlaceHop {
  readonly document: string;
  readonly at: string;
  readonly ref: string;
  readonly target: InPlaceTarget;
}

/** The documents a search reads. */
export interface InPlaceGraph {
  /** The schema a document holds, or undefined when nothing answers it. */
  documentOf(document: string): unknown;
  /** Where a reference written in `document` lands, or undefined when the
   *  search does not follow it. */
  targetOf(ref: string, document: string): InPlaceTarget | undefined;
}

/**
 * The target of `ref` written in `document` for a search answering named
 * documents through `lookup`: a local pointer stays in `document`, any other
 * reference names the document before its `#` — but the built-in manifest
 * fragments, which hold no author schema.
 */
export function lookupTarget(ref: string, document: string, has: (id: string) => boolean): InPlaceTarget | undefined {
  const { shape, pointer } = schemaReferenceParts(ref);
  if (shape === undefined) return { document, pointer: canonicalPointer(pointer) };
  if (shape === MANIFEST_SCHEMA_URI || !has(shape)) return undefined;
  return { document: shape, pointer: canonicalPointer(pointer) };
}

interface Node {
  readonly key: string;
  readonly document: string;
  readonly at: string;
  readonly ref: string;
}

const nodeKey = (document: string, at: string): string => `${document}\u0000${at}`;

/** The reference graph of a search, its nodes and successors memoised. */
class PlainGraph {
  private readonly successorMemo = new Map<string, { node: Node; hop: InPlaceHop }[]>();
  constructor(private readonly graph: InPlaceGraph) {}

  nodesOf(document: string): Node[] {
    return writtenReferences(this.graph.documentOf(document)).map(({ at, ref }) => ({
      key: nodeKey(document, at),
      document,
      at,
      ref,
    }));
  }

  successors(node: Node): { node: Node; hop: InPlaceHop }[] {
    const known = this.successorMemo.get(node.key);
    if (known) return known;
    const out: { node: Node; hop: InPlaceHop }[] = [];
    const target = this.graph.targetOf(node.ref, node.document);
    if (target) {
      const schema = this.graph.documentOf(target.document);
      if (schema !== undefined) {
        const hop: InPlaceHop = { document: node.document, at: node.at, ref: node.ref, target };
        for (const { at, ref } of inPlaceReferences(schema, target.pointer)) {
          out.push({ node: { key: nodeKey(target.document, at), document: target.document, at, ref }, hop });
        }
      }
    }
    this.successorMemo.set(node.key, out);
    return out;
  }
}

/**
 * The first in-place cycle through a reference `document` writes, as the hops
 * that close it in order, or undefined when there is none.
 */
export function inPlaceCycleThrough(document: string, graph: InPlaceGraph): InPlaceHop[] | undefined {
  const plain = new PlainGraph(graph);
  for (const seed of plain.nodesOf(document)) {
    const cycle = cycleBack(seed, plain);
    if (cycle) return cycle;
  }
  return undefined;
}

/** The hops of a path from `seed` back to itself, breadth first. */
function cycleBack(seed: Node, plain: PlainGraph): InPlaceHop[] | undefined {
  const parent = new Map<string, { from: string; hop: InPlaceHop }>();
  const queue: Node[] = [seed];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const { node: next, hop } of plain.successors(node)) {
      if (next.key === seed.key) {
        const hops = [hop];
        let at = node.key;
        while (at !== seed.key) {
          const step = parent.get(at)!;
          hops.unshift(step.hop);
          at = step.from;
        }
        return hops;
      }
      if (seen.has(next.key)) continue;
      seen.add(next.key);
      parent.set(next.key, { from: node.key, hop });
      queue.push(next);
    }
  }
  return undefined;
}

const ROOT_DOCUMENT = "\u0000root";

/**
 * Whether a schema reaches an in-place cycle through any keyword — the question a
 * validator asks before it validates a value against the schema. Named documents
 * are answered by `lookup`; each found free of cycles, with everything it
 * reaches, is remembered, so a named shape is read once per guard.
 */
export class InPlaceCycleGuard {
  private readonly clean = new Set<string>();
  private readonly verdicts = new WeakMap<object, boolean>();

  constructor(private readonly lookup: (id: string) => unknown) {}

  holds(schema: Schema): boolean {
    const known = this.verdicts.get(schema);
    if (known !== undefined) return known;
    const documents = new Map<string, unknown>([[ROOT_DOCUMENT, schema]]);
    const documentOf = (id: string): unknown => {
      if (documents.has(id)) return documents.get(id);
      const found = this.clean.has(id) ? undefined : this.lookup(id);
      documents.set(id, found);
      return found;
    };
    const graph: InPlaceGraph = {
      documentOf,
      targetOf: (ref, document) => lookupTarget(ref, document, (id) => !this.clean.has(id) && documentOf(id) !== undefined),
    };
    const plain = new PlainGraph(graph);
    // Every document reached through any reference, each read whole.
    const nodes: Node[] = [];
    const pending = [ROOT_DOCUMENT];
    const read = new Set<string>(pending);
    while (pending.length > 0) {
      const document = pending.pop()!;
      for (const node of plain.nodesOf(document)) {
        nodes.push(node);
        const target = graph.targetOf(node.ref, document);
        if (target && !read.has(target.document)) {
          read.add(target.document);
          pending.push(target.document);
        }
      }
    }
    const cyclic = holdsCycle(nodes, plain);
    if (!cyclic) for (const document of read) if (document !== ROOT_DOCUMENT) this.clean.add(document);
    this.verdicts.set(schema, cyclic);
    return cyclic;
  }
}

/** Whether the reference graph over `nodes` holds a cycle: a depth-first walk
 *  meeting a node still on its path. */
function holdsCycle(nodes: readonly Node[], plain: PlainGraph): boolean {
  const state = new Map<string, 1 | 2>();
  for (const start of nodes) {
    if (state.has(start.key)) continue;
    const stack: { node: Node; next: number }[] = [{ node: start, next: 0 }];
    state.set(start.key, 1);
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const successors = plain.successors(top.node);
      if (top.next >= successors.length) {
        state.set(top.node.key, 2);
        stack.pop();
        continue;
      }
      const next = successors[top.next++]!.node;
      const seen = state.get(next.key);
      if (seen === 1) return true;
      if (seen === undefined) {
        state.set(next.key, 1);
        stack.push({ node: next, next: 0 });
      }
    }
  }
  return false;
}

/** A pointer as a message quotes it: its root as the document itself. */
const pointerText = (pointer: string): string => (pointer === "#" ? "" : pointer.replace(/^#\//, ""));

/**
 * The refusal's sentence, after `owner` (`'S'`): the hops of the cycle in
 * order, each document named by `label`.
 */
export function inPlaceCycleMessage(owner: string, hops: readonly InPlaceHop[], label: (document: string) => string): string {
  const at = (pointer: string, document: string): string =>
    pointer === "#" ? label(document) : `'${pointerText(pointer)}' of ${label(document)}`;
  const target = (hop: InPlaceHop): string =>
    `${label(hop.target.document)}${hop.target.pointer === "#" ? "" : ` at '${pointerText(hop.target.pointer)}'`}`;
  const chain = hops
    .map((hop, i) => (i === 0 ? `${at(hop.at, hop.document)} refers to ${target(hop)}` : `where ${at(hop.at, hop.document)} refers to ${target(hop)}`))
    .join(", ");
  return (
    `${owner}: its schema comes back to where it started without descending into the value — ${chain} — ` +
    `so validating any value against it never ends. A schema may refer back to itself only beneath ` +
    `${DESCENDING_KEYWORDS.slice(0, -1).map((keyword) => `'${keyword}'`).join(", ")} or '${DESCENDING_KEYWORDS.at(-1)}'.`
  );
}
