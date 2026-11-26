/**
 * Which schema nodes a check read — the answer a host asks for to know which parts of the
 * schemas it handed over a verdict rests on.
 *
 * **A node is read for its own type**: what its keywords say other than through a subschema
 * that is a node of its own — `type`, `const`, `enum`, the names `properties` and the
 * patterns `patternProperties` hold, whether `additionalProperties` is a boolean, how many
 * members `allOf` / `anyOf` / `oneOf` hold, a `$ref`'s text, and whatever the host's
 * resolver answers for it. A subschema the
 * answer depends on is listed as a node of its own, so two versions of a document that
 * agree on the own type of every listed node give one check the same answer.
 *
 * Conversion records, beside each type, what reading it reads (`SchemaReads`): the node it
 * was read at and the nodes reading that node continues into — a reference's target, the
 * document a host resolver answered, a union's branches. A union branch the union dropped as
 * equal to another is read WHOLE, every node beneath it; an intersection is read as what its
 * meeting compared — each part's own type, the node of each part holding a member position as
 * `dyn`, and where several parts type a position, each of their nodes and the positions
 * beneath it — and a container it built carries each member's reads. A reading joined out of
 * several holds them as its parts rather than a copy, so a reading shared by many is one
 * entry wherever it is held; read, it is the sequence a copy of every part's nodes and whole
 * types would be. Each container type
 * the conversion built also knows the node of each member (`SchemaProvenance.edges`), so a
 * check that reads one field of a record lists that field's node and none of its siblings.
 *
 * The checker reads in two ways. A **descent** — a member, an index, a comprehension's
 * element — lists the member's node alone. Any other **use** of a type — an operand, an
 * argument, a branch, the expression's own result — lists everything beneath it, since a
 * verdict about a type may rest on any part of it.
 */

import type { CelType } from "./cel-type.js";
import type { JsonSchemaNode } from "./json-schema-type.js";

/**
 * A schema node a check read: the object its pointer is relative to, and the pointer.
 *
 * `document` is always an object the host handed over — a registration's `schema` or
 * `document`, or a resolver answer's `node` or `root` — so a host matches an entry back by
 * identity. A node reached through a document-local reference is relative to the document
 * the reference resolved against; a node the descent began at, and every node beneath it,
 * to that node.
 */
export interface SchemaDependency {
  readonly document: JsonSchemaNode;
  readonly pointer: string;
}

/** A schema node, and what reading it continues into. */
export interface SchemaNodeRead {
  readonly document: JsonSchemaNode;
  readonly pointer: string;
  readonly reads: SchemaReads;
}

/**
 * What reading a type reads: nodes read for their own type, and types read whole — its own,
 * then each part's in turn, every node before any whole type.
 */
export interface SchemaReads {
  readonly nodes: readonly SchemaNodeRead[];
  readonly whole: readonly WholeRead[];
  /** The readings a joined one holds, in order; absent on one read at one place. */
  readonly parts?: readonly SchemaReads[];
}

/** A type read whole, and what reading it reads. */
export interface WholeRead {
  readonly type: CelType;
  readonly reads: SchemaReads;
}

export const NO_SCHEMA_READS: SchemaReads = { nodes: [], whole: [] };

/** The key of a list's element and of a map's value among a container's member reads. */
export const ELEMENT_EDGE = "*";

/**
 * The key of a record's undeclared members and of a tuple's rest. A symbol, so no property
 * name — `*` included — can stand for it; a tuple's positions are keyed by their index.
 */
export const ADDITIONAL_EDGE: unique symbol = Symbol("additional");

const PATTERN_EDGES: symbol[][] = [];
const PART_ADDITIONAL_EDGES: symbol[] = [];

/**
 * The key of a record's `patternProperties` entry at a position of a part. A symbol per part
 * and position, so no property name can stand for one.
 */
export function patternEdge(part: number, at: number): symbol {
  while (PATTERN_EDGES.length <= part) PATTERN_EDGES.push([]);
  const edges = PATTERN_EDGES[part]!;
  while (edges.length <= at) edges.push(Symbol(`pattern ${part}.${edges.length}`));
  return edges[at]!;
}

/** The key of the type a record's pattern part gives a member another part's pattern matches. */
export function partAdditionalEdge(part: number): symbol {
  while (PART_ADDITIONAL_EDGES.length <= part) PART_ADDITIONAL_EDGES.push(Symbol(`part ${PART_ADDITIONAL_EDGES.length} additional`));
  return PART_ADDITIONAL_EDGES[part]!;
}

/**
 * How a container's member is keyed: a field name, an index, `*`, {@link ADDITIONAL_EDGE}, a
 * {@link patternEdge} or a {@link partAdditionalEdge}.
 */
export type EdgeKey = string | symbol;

/** What one registration's schema conversion knows about where its types came from. */
export interface SchemaProvenance {
  /** What reading the registered type reads. */
  readonly root: SchemaReads;
  /** The node the registered type was read from (`schema-nodes.ts`). */
  readonly rootNode: SchemaDependency;
  /** Per container type the conversion built: each member's reads, by field name or `*`. */
  readonly edges: ReadonlyMap<CelType, ReadonlyMap<EdgeKey, SchemaReads>>;
  /** Per container type the conversion built: the node each member was read from. */
  readonly memberNodes: ReadonlyMap<CelType, ReadonlyMap<EdgeKey, SchemaDependency>>;
  /** Per union type the conversion built: the node each member was read from, in member order. */
  readonly unionNodes: ReadonlyMap<CelType, readonly SchemaDependency[]>;
}

type Pending = { readonly reads: SchemaReads } | { readonly type: CelType } | { readonly cursor: PartsCursor };

/**
 * Where reading a joined bundle's parts has got to, for its nodes' readings or for its whole
 * types: one per bundle and check, so wherever the bundle is reached again its parts go on
 * from here rather than from the start.
 */
interface PartsCursor {
  readonly parts: readonly SchemaReads[];
  readonly whole: boolean;
  at: number;
}

/**
 * The dependencies one check collects, each listed once in the order first read. Every
 * bundle and every type is walked at most once per check, so a type read many times costs
 * one walk, and a joined bundle's parts are listed and read once however many bundles hold
 * it — in the order a copy of every part would have been read.
 */
export class SchemaDependencyRecorder {
  private readonly listed: SchemaDependency[] = [];
  private readonly seen = new Map<JsonSchemaNode, Set<string>>();
  private readonly recorded = new Set<SchemaReads>();
  private readonly walked = new Set<CelType>();
  private readonly touched: SchemaProvenance[] = [];
  /** Joined bundles whose every node is listed. */
  private readonly joinedListed = new Set<SchemaReads>();
  private readonly cursors = new Map<SchemaReads, readonly [PartsCursor, PartsCursor]>();
  /** How many reading entries — nodes, whole types, parts — this check has stepped through. */
  visited = 0;

  /**
   * A registration read: a variable by name, or a namespaced function's result at a call.
   * Its type is read where its root is.
   */
  readRegistration(provenance: SchemaProvenance | undefined): void {
    if (!provenance) return;
    if (!this.touched.includes(provenance)) this.touched.push(provenance);
    this.run([{ reads: provenance.root }]);
  }

  /** A descent from a container into one member: that member's node alone. */
  readMember(container: CelType, key: EdgeKey): void {
    const reads = this.edge(container, key);
    if (reads) this.run([{ reads }]);
  }

  /** A use of a type: everything beneath it. */
  readWhole(type: CelType): void {
    if (!holdsTypes(type) || this.walked.has(type)) return;
    this.run([{ type }]);
  }

  dependencies(): readonly SchemaDependency[] {
    return this.listed;
  }

  private edge(container: CelType, key: EdgeKey): SchemaReads | undefined {
    return this.edgesOf(container)?.get(key);
  }

  private edgesOf(container: CelType): ReadonlyMap<EdgeKey, SchemaReads> | undefined {
    for (const provenance of this.touched) {
      const held = provenance.edges.get(container);
      if (held) return held;
    }
    return undefined;
  }

  /** Pre-order over an explicit stack: a node before what it continues into. */
  private run(start: Pending[]): void {
    const stack = start.reverse();
    while (stack.length > 0) {
      const next = stack.pop()!;
      const children: Pending[] = [];
      if ("cursor" in next) {
        const cursor = next.cursor;
        if (cursor.at === cursor.parts.length) continue;
        const part = cursor.parts[cursor.at++]!;
        this.visited += 1;
        stack.push(next);
        if (part.parts) children.push({ cursor: this.cursorsOf(part)[cursor.whole ? 1 : 0] });
        else if (cursor.whole) this.wholeChildren(part, children);
        else this.nodeChildren(part, children);
      } else if ("reads" in next) {
        if (this.recorded.has(next.reads)) continue;
        this.recorded.add(next.reads);
        this.listAll(next.reads);
        this.nodeChildren(next.reads, children);
        if (next.reads.parts) children.push({ cursor: this.cursorsOf(next.reads)[0] });
        this.wholeChildren(next.reads, children);
        if (next.reads.parts) children.push({ cursor: this.cursorsOf(next.reads)[1] });
      } else {
        if (this.walked.has(next.type)) continue;
        this.walked.add(next.type);
        this.typeChildren(next.type, children);
      }
      for (let at = children.length - 1; at >= 0; at -= 1) stack.push(children[at]!);
    }
  }

  private nodeChildren(reads: SchemaReads, children: Pending[]): void {
    this.visited += reads.nodes.length;
    for (const node of reads.nodes) children.push({ reads: node.reads });
  }

  private wholeChildren(reads: SchemaReads, children: Pending[]): void {
    this.visited += reads.whole.length;
    for (const part of reads.whole) children.push({ reads: part.reads }, { type: part.type });
  }

  private cursorsOf(reads: SchemaReads): readonly [PartsCursor, PartsCursor] {
    let held = this.cursors.get(reads);
    if (!held) {
      held = [
        { parts: reads.parts!, whole: false, at: 0 },
        { parts: reads.parts!, whole: true, at: 0 },
      ];
      this.cursors.set(reads, held);
    }
    return held;
  }

  /** Every node a bundle holds, its own then each part's in turn, a joined part already listed skipped. */
  private listAll(reads: SchemaReads): void {
    if (reads.parts) {
      if (this.joinedListed.has(reads)) return;
      this.joinedListed.add(reads);
    }
    const pending = [reads];
    while (pending.length > 0) {
      const next = pending.pop()!;
      this.visited += next.nodes.length;
      for (const node of next.nodes) this.list(node);
      if (!next.parts) continue;
      this.visited += next.parts.length;
      for (let at = next.parts.length - 1; at >= 0; at -= 1) {
        const part = next.parts[at]!;
        if (part.parts) {
          if (this.joinedListed.has(part)) continue;
          this.joinedListed.add(part);
        }
        pending.push(part);
      }
    }
  }

  private typeChildren(type: CelType, children: Pending[]): void {
    switch (type.kind) {
      case "record": {
        // Every member edge, an absent member's, each pattern's and the undeclared members' included.
        const edges = this.edgesOf(type);
        for (const [name, field] of type.fields) {
          const reads = edges?.get(name);
          if (reads) children.push({ reads });
          children.push({ type: field });
        }
        for (const [key, reads] of edges ?? []) {
          if (typeof key === "string" && type.fields.has(key)) continue;
          children.push({ reads });
        }
        for (const part of type.patternParts ?? []) {
          for (const entry of part.fields) if (entry.type) children.push({ type: entry.type });
          if (part.additionalFields) children.push({ type: part.additionalFields });
        }
        if (type.additionalFields) children.push({ type: type.additionalFields });
        return;
      }
      case "list": {
        const reads = this.edge(type, ELEMENT_EDGE);
        if (reads) children.push({ reads });
        children.push({ type: type.element });
        return;
      }
      case "map": {
        const reads = this.edge(type, ELEMENT_EDGE);
        if (reads) children.push({ reads });
        children.push({ type: type.key }, { type: type.value });
        return;
      }
      case "optional":
        children.push({ type: type.value });
        return;
      case "union":
        for (const member of type.members) children.push({ type: member });
        return;
      default:
        return;
    }
  }

  private list(node: SchemaNodeRead): void {
    let pointers = this.seen.get(node.document);
    if (!pointers) {
      pointers = new Set();
      this.seen.set(node.document, pointers);
    }
    if (pointers.has(node.pointer)) return;
    pointers.add(node.pointer);
    this.listed.push({ document: node.document, pointer: node.pointer });
  }
}

/**
 * Whether a union kept a branch's type as one of its members: a type with no identity of
 * its own (a scalar, `dyn`, a named type) says all it says at its node, so it counts as kept.
 */
export function keptIn(combined: CelType, branch: CelType): boolean {
  if (branch.kind === "union") return branch.members.every((member) => keptIn(combined, member));
  if (!hasIdentity(branch)) return true;
  return combined.kind === "union" ? combined.members.includes(branch) : combined === branch;
}

/** Whether a type holds other types, so walking it could reach a schema node. */
function holdsTypes(type: CelType): boolean {
  return hasIdentity(type) || type.kind === "union";
}

function hasIdentity(type: CelType): boolean {
  return type.kind === "record" || type.kind === "list" || type.kind === "map" || type.kind === "optional";
}

/** One bundle holding several as its parts, each once, read as every node and whole type of each in turn. */
export function joinedReads(parts: readonly SchemaReads[]): SchemaReads {
  const filled = [...new Set(parts)].filter((part) => part.nodes.length > 0 || part.whole.length > 0 || part.parts !== undefined);
  if (filled.length === 0) return NO_SCHEMA_READS;
  if (filled.length === 1) return filled[0]!;
  return { nodes: [], whole: [], parts: filled };
}
