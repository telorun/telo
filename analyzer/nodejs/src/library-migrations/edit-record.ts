/**
 * The edit record of the library migration stage: what the stage changed in one
 * module source, as data every reader of the source applies the same way — the
 * analysis (over the graph's own copies of the trees), the kernel (over fresh
 * copies of its compiled loads, carrying compiled values by position) and
 * write-back.
 *
 * One entry per OUTERMOST rewritten node: its anchor and its converged node. The
 * node is a tree whose leaves are literals or pointers to sub-nodes of the
 * module's trees as they were before the stage, told apart by an envelope, so a
 * literal map never reads as a pointer. A rewrite nested in another is composed
 * into the outer node.
 *
 * Browser-safe: no Node built-ins.
 */
import { cloneMigrationTree } from "./rule-application.js";
import { setOwnProperty } from "../own-property.js";
import { isExpansionSentinel } from "@telorun/templating";

/** A node of a module's trees: a document of one file, and a path inside it. */
export interface MigrationTreePointer {
  readonly file: string;
  readonly document: number;
  readonly path: readonly (string | number)[];
}

/** A converged node: a literal, a map or list of nodes, or a sub-node of the
 *  trees as they were before the stage. */
export type MigrationRecordNode =
  | { readonly literal: string | number | boolean | bigint | null }
  | { readonly map: Readonly<Record<string, MigrationRecordNode>> }
  | { readonly list: readonly MigrationRecordNode[] }
  | { readonly from: MigrationTreePointer };

export interface MigrationRecordEntry {
  readonly anchor: MigrationTreePointer;
  readonly node: MigrationRecordNode;
}

/** Every rewrite of one module source. */
export interface ModuleMigrationRecord {
  /** The module's owner source. */
  readonly module: string;
  /** A digest of each file's text the record was computed from, by source. */
  readonly files: Readonly<Record<string, string>>;
  readonly entries: readonly MigrationRecordEntry[];
}

/** A digest of a file's text: what a record is refused against when the text it
 *  is applied to differs. */
export function migrationTextDigest(text: string): string {
  // Two FNV-1a passes with different offsets: a mismatch detector, not a
  // security boundary.
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193 + 2) >>> 0;
  }
  return `${text.length.toString(36)}-${a.toString(36)}-${b.toString(36)}`;
}

/** The files of `record` whose text is not the text it was computed from. */
export function migrationRecordMismatches(
  record: ModuleMigrationRecord,
  textOf: (file: string) => string | undefined,
): string[] {
  return Object.entries(record.files)
    .filter(([file, digest]) => {
      const text = textOf(file);
      return text === undefined || migrationTextDigest(text) !== digest;
    })
    .map(([file]) => file);
}

function treeValueAt(documents: readonly unknown[] | undefined, pointer: MigrationTreePointer): unknown {
  let at: unknown = documents?.[pointer.document];
  for (const segment of pointer.path) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<string | number, unknown>)[segment];
  }
  return at;
}

/**
 * Applies `record` to the trees `documentsOf` returns, in place: every pointer
 * is read from the trees as they are, then each converged node is placed at its
 * anchor. A pointer read is a copy of its plain containers, its tagged and
 * compiled content kept by position.
 */
export function applyLibraryMigrationRecord(
  record: ModuleMigrationRecord,
  documentsOf: (file: string) => unknown[] | undefined,
): void {
  const materialize = (node: MigrationRecordNode): unknown => {
    if ("literal" in node) return node.literal;
    if ("list" in node) return node.list.map(materialize);
    if ("map" in node) {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node.map)) setOwnProperty(out, key, materialize(child));
      return out;
    }
    const found = treeValueAt(documentsOf(node.from.file), node.from);
    if (found === undefined) {
      throw new Error(`library migration record of ${record.module}: ${node.from.file} document ${node.from.document} holds nothing at /${node.from.path.join("/")}`);
    }
    return cloneMigrationTree(found);
  };
  const values = record.entries.map((entry) => materialize(entry.node));
  record.entries.forEach((entry, i) => {
    const documents = documentsOf(entry.anchor.file);
    if (!documents) throw new Error(`library migration record of ${record.module}: no trees for ${entry.anchor.file}`);
    const { path } = entry.anchor;
    if (path.length === 0) {
      documents[entry.anchor.document] = values[i];
      return;
    }
    const parent = treeValueAt(documents, { ...entry.anchor, path: path.slice(0, -1) });
    if (parent === null || typeof parent !== "object") {
      throw new Error(`library migration record of ${record.module}: ${entry.anchor.file} document ${entry.anchor.document} holds no container at /${path.slice(0, -1).join("/")}`);
    }
    setOwnProperty(parent, path[path.length - 1]!, values[i]);
  });
}

/** Where every node of a module's trees sits, as they were before the stage:
 *  what a converged node's unchanged sub-nodes are encoded as. */
export type MigrationTreeIndex = ReadonlyMap<object, MigrationTreePointer>;

/** The index of `files` (each file's source and documents). */
export function migrationTreeIndex(files: readonly (readonly [string, readonly unknown[]])[]): MigrationTreeIndex {
  const known = new Map<object, MigrationTreePointer>();
  const index = (node: unknown, at: MigrationTreePointer) => {
    if (node === null || typeof node !== "object" || known.has(node)) return;
    known.set(node, at);
    if (Array.isArray(node)) node.forEach((item, i) => index(item, { ...at, path: [...at.path, i] }));
    else if (Object.getPrototypeOf(node) === Object.prototype || isExpansionSentinel(node)) {
      for (const [key, child] of Object.entries(node)) index(child, { ...at, path: [...at.path, key] });
    }
  };
  for (const [file, documents] of files) documents.forEach((doc, document) => index(doc, { file, document, path: [] }));
  return known;
}

/**
 * The record node of `value`, a converged node whose unchanged sub-nodes — of
 * its own document or, through a binding, of another of the module's — are
 * objects `index` holds. Each file a pointer reads is added to `read`.
 */
export function encodeMigratedNode(value: unknown, index: MigrationTreeIndex, read: Set<string>): MigrationRecordNode {
  const encode = (node: unknown): MigrationRecordNode => {
    if (node !== null && typeof node === "object") {
      const at = index.get(node);
      if (at) {
        read.add(at.file);
        return { from: at };
      }
      if (Array.isArray(node)) return { list: node.map(encode) };
      const out: Record<string, MigrationRecordNode> = {};
      for (const [key, child] of Object.entries(node)) out[key] = encode(child);
      return { map: out };
    }
    return { literal: node as string | number | boolean | bigint | null };
  };
  return encode(value);
}
