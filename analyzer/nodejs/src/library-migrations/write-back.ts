/**
 * Write-back of the library migration stage: the edit record of one module
 * rendered into byte splices of the author's own files.
 *
 * A converged node replaces the span of the node it was anchored at, rendered in
 * that node's own style (block or flow, its indentation). An entry kept at the
 * same key, and an item kept at the same index, with an equal value keeps its
 * original text byte for byte, comments included; content that moved is copied
 * from where it was and everything else is rendered fresh, so a comment inside a
 * fresh part is lost and reported. A span holding an anchor or an alias is not
 * written, and neither is any node of a hand-over group with an unwritable
 * member: the group is written whole or not at all.
 *
 * Browser-safe: no Node built-ins.
 */
import { isAlias, isMap, isNode, isScalar, isSeq, Lexer, parseAllDocuments, visit, type Node, type Scalar, type YAMLMap, type YAMLSeq } from "yaml";
import type { LoadedFile } from "../loaded-types.js";
import { isPlainSafe, type TextEdit } from "../yaml-source-edit.js";
import {
  migrationRecordMismatches,
  type MigrationRecordNode,
  type MigrationTreePointer,
  type ModuleMigrationRecord,
} from "./edit-record.js";
import type { LibraryHandOver, LibraryMigrationFinding } from "./stage.js";

type Path = readonly (string | number)[];
type Style = "block" | "flow";

export interface LibraryWriteBackInput {
  readonly record: ModuleMigrationRecord;
  /** The module's own files: the owner and its partials. */
  readonly files: readonly LoadedFile[];
  /** Each copied file's documents as they were before the stage. */
  readonly originals: ReadonlyMap<string, readonly unknown[]>;
  readonly findings: readonly LibraryMigrationFinding[];
  readonly handOvers: readonly LibraryHandOver[];
  /** How a file is named in a reason; defaults to its source. */
  readonly fileLabel?: (source: string) => string;
  /** Files whose nodes wait on something else, by source, each with the reason. */
  readonly blockedFiles?: ReadonlyMap<string, string>;
}

/** One migration's rewrite of one written node. */
export interface LibraryRewriteReport {
  readonly migration: string;
  /** The module declaring the migration. */
  readonly module: string;
  readonly source: string;
  /** The node, as a JSON Pointer. */
  readonly path: string;
  readonly line: number;
  readonly column: number;
}

/** A node the command leaves as written, and why. */
export interface LibraryUnwritableReport {
  readonly migration: string;
  readonly module: string;
  readonly source: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly reason: string;
}

export interface LibraryDroppedComment {
  readonly source: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
  /** The migration of the node whose rewrite loses it. */
  readonly migration: string;
}

export interface LibraryWriteBack {
  /** Splices by file source; empty for a file with nothing to write. */
  readonly edits: ReadonlyMap<string, readonly TextEdit[]>;
  readonly rewrites: readonly LibraryRewriteReport[];
  readonly unwritable: readonly LibraryUnwritableReport[];
  readonly droppedComments: readonly LibraryDroppedComment[];
}

const pointerOf = (path: Path): string => (path.length === 0 ? "/" : `/${path.map((s) => String(s).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`);

const samePath = (a: Path, b: Path): boolean => a.length === b.length && a.every((s, i) => String(s) === String(b[i]));
const startsWith = (path: Path, prefix: Path): boolean => prefix.length <= path.length && prefix.every((s, i) => String(s) === String(path[i]));

function lineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let last = -1;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) {
    line++;
    last = i;
  }
  return { line, column: offset - last };
}

const lineEndOf = (text: string, offset: number): number => {
  const i = text.indexOf("\n", offset);
  return i === -1 ? text.length : i;
};

function trimEndFrom(text: string, start: number, end: number): number {
  let e = Math.min(end, text.length);
  while (e > start && /\s/.test(text[e - 1]!)) e--;
  return e;
}

/** Where a node's tag and anchor begin, or its own start without them. */
function propsStart(text: string, node: Node): number {
  const own = (node as { range?: [number, number, number] | null }).range?.[0] ?? 0;
  const tagged = (node as { tag?: string }).tag || (node as { anchor?: string }).anchor;
  if (!tagged) return own;
  let start = own;
  for (;;) {
    let p = start;
    while (p > 0 && text[p - 1] === " ") p--;
    if (p === start) break;
    let t = p;
    while (t > 0 && !/[\s[{,]/.test(text[t - 1]!)) t--;
    if (t < p && (text[t] === "!" || text[t] === "&")) start = t;
    else break;
  }
  return start;
}

function valueEnd(text: string, node: Node): number {
  const range = (node as { range?: [number, number, number] | null }).range;
  if (!range) return 0;
  return trimEndFrom(text, range[0], range[1]);
}

/** The node at `path` of a document's AST. */
function astAt(file: LoadedFile, document: number, path: Path): Node | undefined {
  let at: unknown = file.documents[document]?.contents;
  for (const segment of path) {
    if (isMap(at)) at = at.items.find((p) => isScalar(p.key) && String(p.key.value) === String(segment))?.value;
    else if (isSeq(at)) at = at.items[Number(segment)];
    else return undefined;
    if (at === null || at === undefined) return undefined;
  }
  return isNode(at) ? (at as Node) : undefined;
}

function treeAt(documents: readonly unknown[] | undefined, document: number, path: Path): { found: boolean; value?: unknown } {
  let at: unknown = documents?.[document];
  for (const segment of path) {
    if (at === null || typeof at !== "object" || !(segment in (at as object))) return { found: false };
    at = (at as Record<string | number, unknown>)[segment];
  }
  return { found: true, value: at };
}

const isCollection = (node: unknown): node is YAMLMap | YAMLSeq => isMap(node) || isSeq(node);
const isFlow = (node: YAMLMap | YAMLSeq): boolean => node.flow === true;

/** The first anchor or alias in `node`'s subtree, with where it is. */
function anchorIn(text: string, node: Node): { what: string; offset: number } | undefined {
  let found: { what: string; offset: number } | undefined;
  const check = (n: unknown) => {
    if (found) return;
    if (isAlias(n)) found = { what: `an alias \`*${n.source}\``, offset: n.range?.[0] ?? 0 };
    else if (isNode(n) && (n as { anchor?: string }).anchor) {
      found = { what: `the anchor \`${(n as { anchor: string }).anchor}\``, offset: propsStart(text, n as Node) };
    }
  };
  check(node);
  if (!found) visit(node, { Node: (_key, n) => void check(n), Alias: (_key, n) => void check(n) });
  return found;
}

interface Extent {
  readonly start: number;
  readonly end: number;
  /** Whether the text starts at a line's start. */
  readonly lineStart: boolean;
}

/** The original text of entry `index` of a collection: the lines after the
 *  previous entry through this entry and its trailing comment. */
function extentOf(text: string, collection: YAMLMap | YAMLSeq, index: number): Extent | undefined {
  const entries = (collection.items as unknown[]).map((item): { start: number; end: number } | undefined => {
    let node: Node | null | undefined;
    let start: number;
    if (isMap(collection)) {
      const pair = item as { key: Node; value: Node | null };
      const key = pair.key as Scalar;
      if (!key?.range) return undefined;
      start = key.range[0];
      node = pair.value;
      const keyEnd = key.range[1];
      let end: number;
      if (node && isNode(node) && (node as Node).range && ((node as Node).range![1] > (node as Node).range![0] || (node as { tag?: string }).tag)) {
        end = valueEnd(text, node);
      } else {
        const colon = text.indexOf(":", keyEnd);
        end = colon === -1 ? keyEnd : colon + 1;
      }
      return { start, end };
    }
    node = item as Node | null;
    if (!node || !isNode(node) || !node.range) return undefined;
    if (collection.flow) return { start: propsStart(text, node), end: valueEnd(text, node) };
    let dash = propsStart(text, node);
    while (dash > 0 && text[dash - 1] === " ") dash--;
    if (text[dash - 1] === "-") dash--;
    return { start: dash, end: valueEnd(text, node) };
  });
  const own = entries[index];
  if (!own) return undefined;
  const withComment = (end: number): number => {
    let p = end;
    while (text[p] === " " || text[p] === "\t") p++;
    return text[p] === "#" ? lineEndOf(text, p) : end;
  };
  if (collection.flow) return { start: own.start, end: own.end, lineStart: false };
  const end = withComment(own.end);
  if (index === 0) return { start: own.start, end, lineStart: false };
  const previous = entries[index - 1];
  if (!previous) return undefined;
  return { start: lineEndOf(text, withComment(previous.end)) + 1, end, lineStart: true };
}

const BARE_KEY = /^[A-Za-z_][\w.-]*$/;
const PLAIN_AMBIGUOUS = /^(true|false|null|~|yes|no|on|off|[-+]?(\.?\d|\.inf|\.nan).*)$/i;

function scalarText(value: string | number | boolean | bigint | null): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    return isPlainSafe(value) && !PLAIN_AMBIGUOUS.test(value) && !/^[=<>|]/.test(value) && value !== "<<" ? value : JSON.stringify(value);
  }
  return String(value);
}

const keyText = (key: string): string => (BARE_KEY.test(key) && !PLAIN_AMBIGUOUS.test(key) && key !== "<<" ? key : isPlainSafe(key) && !PLAIN_AMBIGUOUS.test(key) && !/^[=<>|]/.test(key) ? key : JSON.stringify(key));

const pad = (n: number): string => " ".repeat(n);

/** A rendered value: text on the line of its key, or lines of its own. */
type Rendered = { readonly inline: string } | { readonly lines: readonly string[]; readonly header?: string };

interface Keep {
  readonly start: number;
  readonly end: number;
}

interface RenderContext {
  readonly file: LoadedFile;
  readonly document: number;
  readonly path: Path;
}

/** Renders the converged nodes of one module. */
class Renderer {
  /** The original ranges the current anchor's output copies verbatim. */
  kept: Keep[] = [];

  constructor(
    private readonly files: ReadonlyMap<string, LoadedFile>,
    private readonly originals: ReadonlyMap<string, readonly unknown[]>,
  ) {}

  private text(file: LoadedFile): string {
    return file.text;
  }

  /** Whether `node` at `path` of the anchor's document is kept as written. */
  private keptAs(node: MigrationRecordNode, ctx: RenderContext, path: Path): boolean {
    if ("from" in node) {
      return node.from.file === ctx.file.source && node.from.document === ctx.document && samePath(node.from.path, path);
    }
    if ("literal" in node) {
      const original = treeAt(this.originals.get(ctx.file.source), ctx.document, path);
      return original.found && original.value === node.literal;
    }
    return false;
  }

  render(node: MigrationRecordNode, ctx: RenderContext, orig: Node | undefined, style: Style, indent: number, owner: number): Rendered {
    if ("literal" in node) return { inline: scalarText(node.literal) };
    if ("from" in node) {
      const file = this.files.get(node.from.file);
      const source = file && astAt(file, node.from.document, node.from.path);
      if (!file || !source) throw new Error(`no source for ${node.from.file} /${node.from.path.join("/")}`);
      return this.moved(file, source, style, indent, owner);
    }
    const isList = "list" in node;
    const children: [string | number, MigrationRecordNode][] = isList
      ? node.list.map((child, i) => [i, child])
      : Object.entries(node.map);
    if (children.length === 0) return { inline: isList ? "[]" : "{}" };
    const origCollection = orig && isCollection(orig) && isMap(orig) === !isList ? orig : undefined;
    const effective: Style = style === "flow" ? "flow" : origCollection ? (isFlow(origCollection) ? "flow" : "block") : "block";
    const text = this.text(ctx.file);
    const keepable = origCollection && (isFlow(origCollection) ? effective === "flow" : effective === "block");

    const pieces = children.map(([key, child]) => {
      const path = [...ctx.path, key];
      const origChild = origCollection
        ? isMap(origCollection)
          ? (origCollection.items.find((p) => isScalar(p.key) && String(p.key.value) === String(key))?.value as Node | undefined)
          : (origCollection.items[key as number] as Node | undefined)
        : undefined;
      let kept: Keep | undefined;
      let keptLineStart = false;
      if (keepable && this.keptAs(child, ctx, path)) {
        const index = isMap(origCollection)
          ? origCollection.items.findIndex((p) => isScalar(p.key) && String(p.key.value) === String(key))
          : (key as number);
        const extent = extentOf(text, origCollection, index);
        if (extent) {
          kept = { start: extent.start, end: extent.end };
          keptLineStart = extent.lineStart;
        }
      }
      return { key, child, path, origChild, kept, keptLineStart };
    });

    if (effective === "flow") {
      const parts = pieces.map((piece) => {
        if (piece.kept) {
          this.kept.push(piece.kept);
          return text.slice(piece.kept.start, piece.kept.end).replace(/^[\s,]+/, "").replace(/\s+$/, "");
        }
        const r = this.render(piece.child, { ...ctx, path: piece.path }, piece.origChild, "flow", indent, owner);
        const inline = "inline" in r ? r.inline : r.lines.join(" ");
        return isList ? inline : `${keyText(String(piece.key))}: ${inline}`;
      });
      return { inline: isList ? `[${parts.join(", ")}]` : `{ ${parts.join(", ")} }` };
    }

    // Block: entries sit at the column the original's do, so kept text stays put.
    const column = origCollection ? this.columnOf(text, origCollection) : indent;
    const lines: string[] = [];
    for (const piece of pieces) {
      if (piece.kept) {
        this.kept.push(piece.kept);
        const raw = text.slice(piece.kept.start, piece.kept.end);
        lines.push(piece.keptLineStart ? raw : pad(column) + raw);
        continue;
      }
      const childIndent = piece.origChild && isCollection(piece.origChild) && !isFlow(piece.origChild)
        ? this.columnOf(text, piece.origChild)
        : column + 2;
      const r = this.render(piece.child, { ...ctx, path: piece.path }, piece.origChild, "block", Math.max(childIndent, column + (isList ? 2 : 1)), column);
      if (isList) {
        if ("inline" in r) lines.push(`${pad(column)}- ${r.inline}`);
        else if (r.header !== undefined) lines.push(`${pad(column)}- ${r.header}`, ...r.lines);
        else lines.push(`${pad(column)}- ${r.lines[0]!.trimStart()}`, ...r.lines.slice(1));
      } else {
        const k = keyText(String(piece.key));
        if ("inline" in r) lines.push(`${pad(column)}${k}: ${r.inline}`);
        else lines.push(`${pad(column)}${k}:${r.header !== undefined ? ` ${r.header}` : ""}`, ...r.lines);
      }
    }
    return { lines };
  }

  /** The column a block collection's entries sit at. */
  private columnOf(text: string, collection: YAMLMap | YAMLSeq): number {
    const first = collection.items[0] as unknown;
    let offset: number;
    if (isMap(collection)) offset = ((first as { key: Scalar }).key.range ?? [0])[0]!;
    else {
      const node = first as Node;
      let dash = propsStart(text, node);
      while (dash > 0 && text[dash - 1] === " ") dash--;
      offset = text[dash - 1] === "-" ? dash - 1 : dash;
    }
    return offset - (text.lastIndexOf("\n", offset - 1) + 1);
  }

  /** Content copied from `node`, laid out for a position of `style`. */
  private moved(file: LoadedFile, node: Node, style: Style, indent: number, owner: number): Rendered {
    const text = this.text(file);
    const tag = (node as { tag?: string }).tag;
    const start = propsStart(text, node);
    if (isScalar(node)) {
      const range = node.range;
      const raw = range ? text.slice(start, valueEnd(text, node)) : "";
      const body = raw === "" ? (tag ? `${tag}` : "null") : raw;
      if (node.type === "BLOCK_LITERAL" || node.type === "BLOCK_FOLDED") {
        if (style === "flow") return { inline: `${tag ? `${tag} ` : ""}${JSON.stringify(String(node.value))}` };
        const [header, ...content] = body.split("\n");
        const lead = content.find((l) => l.trim() !== "")?.match(/^ */)![0].length ?? 0;
        return { inline: [header, ...content.map((l) => (l.trim() === "" ? "" : pad(owner + 2) + l.slice(lead)))].join("\n") };
      }
      if (range) this.kept.push({ start, end: valueEnd(text, node) });
      return { inline: body };
    }
    if (isCollection(node)) {
      if (isFlow(node)) {
        this.kept.push({ start, end: valueEnd(text, node) });
        return { inline: text.slice(start, valueEnd(text, node)) };
      }
      const header = tag;
      if (style === "flow") {
        const parts = isMap(node)
          ? node.items.map((p) => {
              const key = text.slice((p.key as Scalar).range![0], (p.key as Scalar).range![1]);
              const r = p.value ? this.moved(file, p.value as Node, "flow", indent, owner) : { inline: "null" };
              return `${key}: ${"inline" in r ? r.inline : r.lines.join(" ")}`;
            })
          : (node.items as Node[]).map((item) => {
              const r = this.moved(file, item, "flow", indent, owner);
              return "inline" in r ? r.inline : r.lines.join(" ");
            });
        const body = isMap(node) ? `{ ${parts.join(", ")} }` : `[${parts.join(", ")}]`;
        return { inline: `${header ? `${header} ` : ""}${body}` };
      }
      const lines: string[] = [];
      if (isMap(node)) {
        for (const pair of node.items) {
          const key = text.slice((pair.key as Scalar).range![0], (pair.key as Scalar).range![1]);
          if (!pair.value) {
            lines.push(`${pad(indent)}${key}:`);
            continue;
          }
          const r = this.moved(file, pair.value as Node, "block", indent + 2, indent);
          if ("inline" in r) lines.push(`${pad(indent)}${key}: ${r.inline}`);
          else lines.push(`${pad(indent)}${key}:${r.header !== undefined ? ` ${r.header}` : ""}`, ...r.lines);
        }
      } else {
        for (const item of node.items as (Node | null)[]) {
          if (!item) {
            lines.push(`${pad(indent)}-`);
            continue;
          }
          const r = this.moved(file, item, "block", indent + 2, indent);
          if ("inline" in r) lines.push(`${pad(indent)}- ${r.inline}`);
          else if (r.header !== undefined) lines.push(`${pad(indent)}- ${r.header}`, ...r.lines);
          else lines.push(`${pad(indent)}- ${r.lines[0]!.trimStart()}`, ...r.lines.slice(1));
        }
      }
      return header ? { lines, header } : { lines };
    }
    throw new Error("an alias cannot be copied");
  }
}

interface AnchorState {
  readonly index: number;
  readonly source: string;
  readonly file: LoadedFile | undefined;
  readonly document: number;
  readonly path: Path;
  readonly node: Node | undefined;
  /** Why this node cannot be written on its own. */
  reason?: string;
  /** The anchor or alias behind the reason, when that is it. */
  hold?: { at: string; what: string };
  /** The hand-over reason that withholds it, with whether it is the member reported. */
  group?: { reason: string; reported: boolean; migration: string };
  migrations: { code: string; module: string }[];
}

/** The comment tokens of a file with their offsets. */
function commentsOf(text: string): { offset: number; text: string }[] {
  const out: { offset: number; text: string }[] = [];
  let offset = 0;
  for (const token of new Lexer().lex(text)) {
    if (token.length === 1 && token.charCodeAt(0) < 0x20 && token !== "\n" && token !== "\t") continue;
    if (token.startsWith("#")) out.push({ offset, text: token });
    offset += token.length;
  }
  return out;
}

/** The edits that write `input.record` into the module's own files. */
export function planLibraryWriteBack(input: LibraryWriteBackInput): LibraryWriteBack {
  const label = input.fileLabel ?? ((source: string) => source);
  const files = new Map(input.files.map((file) => [file.source, file]));
  const renderer = new Renderer(files, input.originals);
  const place = (file: LoadedFile, offset: number): string => {
    const { line, column } = lineColumn(file.text, offset);
    return `${label(file.source)}:${line}:${column}`;
  };

  const stale = new Set(migrationRecordMismatches(input.record, (source) => files.get(source)?.text));
  const anchors: AnchorState[] = input.record.entries.map((entry, index) => {
    const file = files.get(entry.anchor.file);
    const node = file && astAt(file, entry.anchor.document, entry.anchor.path);
    return { index, source: entry.anchor.file, file, document: entry.anchor.document, path: entry.anchor.path, node, migrations: [] };
  });

  const containing = (pointer: MigrationTreePointer): AnchorState | undefined =>
    anchors.find((a) => a.source === pointer.file && a.document === pointer.document && startsWith(pointer.path, a.path));

  for (const finding of input.findings) {
    if (finding.code === "MIGRATION_FAILED" || finding.modulePath !== input.record.module) continue;
    const anchor = containing(finding.at);
    if (anchor && !anchor.migrations.some((m) => m.code === finding.code && m.module === finding.library.module)) {
      anchor.migrations.push({ code: finding.code, module: finding.library.module });
    }
  }

  // Each anchor's own obstacles.
  anchors.forEach((anchor, i) => {
    const entry = input.record.entries[i]!;
    const where = anchor.file ? `${place(anchor.file, anchor.node ? propsStart(anchor.file.text, anchor.node) : 0)} (${pointerOf(anchor.path)})` : anchor.source;
    if (!anchor.file) anchor.reason = `${label(anchor.source)} is not one of the module's own files, so it is not written.`;
    else if (input.blockedFiles?.has(anchor.source)) anchor.reason = input.blockedFiles.get(anchor.source)!;
    else if (stale.has(anchor.source)) anchor.reason = `${label(anchor.source)} changed after it was loaded. Run again.`;
    else if (!anchor.node) anchor.reason = `${where} cannot be located in the file. Fix it by hand.`;
    else if ((anchor.node as { tag?: string }).tag) anchor.reason = `${where} carries a tag the rewrite would drop. Fix it by hand.`;
    else {
      const holds = anchorIn(anchor.file.text, anchor.node);
      if (holds) {
        anchor.hold = { at: place(anchor.file, holds.offset), what: holds.what };
        anchor.reason = `${anchor.hold.at} (${pointerOf(anchor.path)}) holds ${holds.what}. Remove it and run again.`;
        return;
      }
      for (const from of pointers(entry.node)) {
        const sourceFile = files.get(from.file);
        const sourceNode = sourceFile && astAt(sourceFile, from.document, from.path);
        const inside = sourceFile && sourceNode ? anchorIn(sourceFile.text, sourceNode) : undefined;
        if (sourceFile && inside) {
          anchor.hold = { at: place(sourceFile, inside.offset), what: inside.what };
          anchor.reason = `${anchor.hold.at} (${pointerOf(from.path)}) holds ${inside.what}, which its rewrite at ${where} copies. Remove it and run again.`;
          return;
        }
        if (!sourceNode) {
          anchor.reason = `${where} copies ${label(from.file)} ${pointerOf(from.path)}, which cannot be located in the file. Fix it by hand.`;
          return;
        }
      }
    }
  });

  // A hand-over is written whole or not at all.
  const groupReports: LibraryUnwritableReport[] = [];
  const intactGroups: { head: string; group: AnchorState[] }[] = [];
  for (const handOver of input.handOvers) {
    if (handOver.modulePath !== input.record.module) continue;
    const members = [handOver.referent, ...handOver.members];
    const group = [...new Set(members.map(containing).filter((a): a is AnchorState => a !== undefined))];
    const blocking = group.find((a) => a.reason !== undefined);
    const referentFile = files.get(handOver.referent.file);
    const referentAt = referentFile
      ? place(referentFile, propsStart(referentFile.text, astAt(referentFile, handOver.referent.document, handOver.referent.path) ?? (referentFile.documents[handOver.referent.document]!.contents as Node)))
      : label(handOver.referent.file);
    const head = `the hand-over of ${handOver.label} (${referentAt}) has an unwritable member —`;
    if (!blocking) {
      intactGroups.push({ head, group });
      continue;
    }
    const finalReason = blocking.hold
      ? `${head} ${blocking.hold.at} holds ${blocking.hold.what}. Remove the ${blocking.hold.what.includes("alias") ? "alias" : "anchor"} and run again.`
      : `${head} ${blocking.reason}`;
    for (const a of group) a.group ??= { reason: finalReason, reported: false, migration: handOver.migration };
    if (blocking.file && !blocking.group!.reported) {
      blocking.group!.reported = true;
      const at = blocking.node ? propsStart(blocking.file.text, blocking.node) : 0;
      const { line, column } = lineColumn(blocking.file.text, at);
      groupReports.push({
        migration: handOver.migration,
        module: handOver.library,
        source: blocking.source,
        path: pointerOf(blocking.path),
        line,
        column,
        reason: finalReason,
      });
    }
  }

  const comments = new Map<string, { offset: number; text: string }[]>();
  const commentsIn = (file: LoadedFile) => {
    let found = comments.get(file.source);
    if (!found) comments.set(file.source, (found = commentsOf(file.text)));
    return found;
  };

  const edits = new Map<string, TextEdit[]>();
  const rewrites: LibraryRewriteReport[] = [];
  const unwritable: LibraryUnwritableReport[] = [...groupReports];
  const dropped: LibraryDroppedComment[] = [];
  const written: { anchor: AnchorState; edit: TextEdit; dropped: LibraryDroppedComment[] }[] = [];

  const lateFailures = new Map<AnchorState, string>();
  const failAnchor = (anchor: AnchorState, reason: string) => {
    const at = anchor.file && anchor.node ? lineColumn(anchor.file.text, propsStart(anchor.file.text, anchor.node)) : { line: 1, column: 1 };
    unwritable.push({
      migration: anchor.migrations[0]?.code ?? "LIBRARY_MIGRATION",
      module: anchor.migrations[0]?.module ?? "",
      source: anchor.source,
      path: pointerOf(anchor.path),
      line: at.line,
      column: at.column,
      reason,
    });
  };

  for (const anchor of anchors) {
    const entry = input.record.entries[anchor.index]!;
    if (anchor.group) continue;
    if (anchor.reason) {
      failAnchor(anchor, anchor.reason);
      continue;
    }
    const file = anchor.file!;
    const node = anchor.node!;
    const text = file.text;
    const ctx: RenderContext = { file, document: anchor.document, path: anchor.path };
    renderer.kept = [];
    let rendered: Rendered;
    try {
      const style: Style = isCollection(node) ? (isFlow(node) ? "flow" : "block") : "flow";
      const column = isCollection(node) && !isFlow(node) ? columnOfCollection(text, node) : 0;
      rendered = renderer.render(entry.node, ctx, node, style, column, Math.max(column - 2, 0));
    } catch (error) {
      lateFailures.set(anchor, `${place(file, propsStart(text, node))} (${pointerOf(anchor.path)}) cannot be rendered: ${error instanceof Error ? error.message : String(error)}. Fix it by hand.`);
      continue;
    }
    let spanStart: number;
    let spanEnd: number;
    if (isCollection(node) && !isFlow(node)) {
      const last = node.items.length - 1;
      const first = extentOf(text, node, 0);
      const closing = extentOf(text, node, last);
      if (!first || !closing) {
        lateFailures.set(anchor, `${place(file, propsStart(text, node))} (${pointerOf(anchor.path)}) cannot be located in the file. Fix it by hand.`);
        continue;
      }
      spanStart = first.start;
      spanEnd = closing.end;
    } else {
      spanStart = propsStart(text, node);
      spanEnd = valueEnd(text, node);
      if (isScalar(node) && node.range && node.range[1] === node.range[0]) spanEnd = spanStart;
    }
    const newText = "inline" in rendered ? rendered.inline : rendered.lines.join("\n").replace(/^\s+/, "");
    const keptRanges = renderer.kept;
    const lost = commentsIn(file)
      .filter((c) => c.offset >= spanStart && c.offset < spanEnd && !keptRanges.some((k) => c.offset >= k.start && c.offset < k.end))
      .map((c) => {
        const { line, column } = lineColumn(text, c.offset);
        return { source: file.source, line, column, text: c.text, migration: anchor.migrations[0]?.code ?? "" };
      });
    written.push({ anchor, edit: { start: spanStart, end: spanEnd, newText }, dropped: lost });
  }

  // A rewrite must leave valid YAML, and a hand-over is written whole or not at
  // all: a failure withdraws the rest of its group, which can fail a parse
  // check again, so both run to a fixpoint.
  const parses = parseCheck;
  const surviving = () => written.filter((item) => !lateFailures.has(item.anchor));
  for (let changed = true; changed; ) {
    changed = false;
    for (const { head, group } of intactGroups) {
      const failedMember = group.find((a) => lateFailures.has(a));
      if (!failedMember) continue;
      for (const a of group) {
        if (lateFailures.has(a)) continue;
        lateFailures.set(a, `${head} ${lateFailures.get(failedMember)}`);
        changed = true;
      }
    }
    const byFile = new Map<string, typeof written>();
    for (const item of surviving()) {
      const list = byFile.get(item.anchor.source) ?? [];
      list.push(item);
      byFile.set(item.anchor.source, list);
    }
    for (const [source, items] of byFile) {
      const file = files.get(source)!;
      const apply = (list: typeof written): string => {
        let out = file.text;
        for (const item of [...list].sort((a, b) => b.edit.start - a.edit.start)) {
          out = out.slice(0, item.edit.start) + item.edit.newText + out.slice(item.edit.end);
        }
        return out;
      };
      if (parses(apply(items))) continue;
      for (const item of items) {
        if (parses(apply([item]))) continue;
        lateFailures.set(item.anchor, `${place(file, item.edit.start)} (${pointerOf(item.anchor.path)}) could not be rendered as valid YAML. Fix it by hand.`);
        changed = true;
      }
    }
  }
  for (const [anchor, reason] of lateFailures) failAnchor(anchor, reason);
  const byFile = new Map<string, typeof written>();
  for (const item of surviving()) {
    const list = byFile.get(item.anchor.source) ?? [];
    list.push(item);
    byFile.set(item.anchor.source, list);
  }
  for (const [source, items] of byFile) {
    const file = files.get(source)!;
    edits.set(source, items.map((g) => g.edit));
    for (const item of items) {
      dropped.push(...item.dropped);
      for (const m of item.anchor.migrations) {
        const { line, column } = lineColumn(file.text, item.edit.start);
        rewrites.push({ migration: m.code, module: m.module, source, path: pointerOf(item.anchor.path), line, column });
      }
    }
  }
  return { edits, rewrites, unwritable, droppedComments: dropped };
}

function columnOfCollection(text: string, node: YAMLMap | YAMLSeq): number {
  const first = node.items[0] as unknown;
  let offset: number;
  if (isMap(node)) offset = ((first as { key: Scalar }).key.range ?? [0])[0]!;
  else {
    const item = first as Node;
    let dash = propsStart(text, item);
    while (dash > 0 && text[dash - 1] === " ") dash--;
    offset = text[dash - 1] === "-" ? dash - 1 : dash;
  }
  return offset - (text.lastIndexOf("\n", offset - 1) + 1);
}

/** Every pointer a converged node reads. */
function pointers(node: MigrationRecordNode): MigrationTreePointer[] {
  if ("from" in node) return [node.from];
  if ("list" in node) return node.list.flatMap(pointers);
  if ("map" in node) return Object.values(node.map).flatMap(pointers);
  return [];
}

function parseCheck(text: string): boolean {
  return parseAllDocuments(text).every((doc) => doc.errors.length === 0);
}
