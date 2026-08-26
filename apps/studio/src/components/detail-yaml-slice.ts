import type { AstDocument, AstNode } from "@telorun/analyzer";
import type { ModuleSourceFile } from "../model";

/**
 * A span of a file's source text, dedented so it stands on its own in an editor.
 *
 * The span is the AUTHOR'S BYTES, never a re-serialization: the detail panel's
 * YAML pane shows what is in the file — comments, quoting style, block scalars,
 * anchors — and writes the same span back. Re-serializing the projected fields
 * would be simpler and would disagree with the source view about the same
 * lines, which is the whole reason to show YAML rather than a form.
 *
 * `indent` is the only transformation, and it is reversible: a node nested three
 * levels deep starts mid-line (its own leading whitespace lies BEFORE the span),
 * while its continuation lines carry the nesting. Stripping their common indent
 * makes the slice readable; adding it back on write makes the splice a no-op for
 * every line the user did not touch.
 */
export interface YamlSlice {
  /** Byte offsets into the file text the slice was taken from. */
  start: number;
  end: number;
  /** The span's text, `indent` stripped from every line but the first and the
   *  line break that ends the node held back in `trailing`. */
  text: string;
  /** Common indentation of the span's continuation lines. */
  indent: string;
  /** The line break ending the span, or "" when the node ends mid-line. A block
   *  collection's range covers the break that terminates it; showing it as an
   *  empty last line invites deleting it, and splicing an edit that lacks it
   *  would run the node into whatever follows. */
  trailing: string;
  /** The file's line ending, restored on write so a CRLF file stays CRLF. */
  eol: string;
}

export interface LocatedSlice {
  filePath: string;
  /** The file text the slice indexes — what a write splices into. */
  fileText: string;
  slice: YamlSlice;
}

function entryValue(node: AstNode | undefined, key: string): AstNode | undefined {
  if (node?.kind !== "map") return undefined;
  for (const entry of node.entries) {
    if (entry.key.kind === "scalar" && entry.key.value === key) return entry.value;
  }
  return undefined;
}

function scalarValue(node: AstNode | undefined): unknown {
  return node?.kind === "scalar" ? node.value : undefined;
}

/** The document declaring `kind` / `metadata.name`, or undefined when the file
 *  holds no such document (the resource lives in a partial, or was renamed in
 *  memory and not yet written back). */
export function findResourceDocument(
  documents: AstDocument[],
  kind: string,
  name: string,
): AstDocument | undefined {
  return documents.find(
    (doc) =>
      scalarValue(entryValue(doc.root, "kind")) === kind &&
      scalarValue(entryValue(entryValue(doc.root, "metadata"), "name")) === name,
  );
}

/** Walks an RFC 6901 pointer to the node it names. An empty pointer is the
 *  document root. Returns undefined for a path the source does not write — a
 *  step's `inputs:` that has never been filled in has no bytes to slice. */
export function nodeAtPointer(
  root: AstNode | undefined,
  pointer: string,
): AstNode | undefined {
  if (!root) return undefined;
  if (pointer === "") return root;
  let current: AstNode | undefined = root;
  for (const raw of pointer.replace(/^\//, "").split("/")) {
    if (!current) return undefined;
    const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (current.kind === "seq") {
      if (!/^\d+$/.test(segment)) return undefined;
      current = current.items[Number(segment)];
    } else {
      current = entryValue(current, segment);
    }
  }
  return current;
}

/**
 * How deep the span's continuation lines sit — what is stripped for display and
 * added back on write, including to lines the user adds.
 *
 * Two sources, and both are needed. The span's own continuation lines are the
 * evidence when there are any, and they are what makes a block scalar work: its
 * range starts at the `|` indicator, so its body is LESS indented than the node
 * starts, and dedenting by the start column would corrupt it. A single-line node
 * carries no such evidence at all, so the node's start column stands in — that
 * is the case for the common `inputs: {one key}`, where a second key typed into
 * the pane must still land under the first.
 */
function commonIndent(lines: string[], startColumn: number): string {
  let width = startColumn;
  for (const line of lines.slice(1)) {
    if (line.trim() === "") continue;
    width = Math.min(width, /^ */.exec(line)![0].length);
  }
  return " ".repeat(width);
}

export function sliceOf(fileText: string, node: AstNode): YamlSlice {
  const [start, end] = node.range;
  const raw = fileText.slice(start, end);
  const eol = raw.includes("\r\n") || fileText.includes("\r\n") ? "\r\n" : "\n";
  const trailing = raw.endsWith("\r\n") ? "\r\n" : raw.endsWith("\n") ? "\n" : "";
  const lines = raw.slice(0, raw.length - trailing.length).split(/\r?\n/);
  const indent = commonIndent(lines, start - (fileText.lastIndexOf("\n", start - 1) + 1));
  const text = [
    lines[0],
    ...lines.slice(1).map((line) => (line.trim() === "" ? "" : line.slice(indent.length))),
  ].join("\n");
  return { start, end, text, indent, trailing, eol };
}

/** The file text with `edited` written back over the slice's span. Continuation
 *  lines are re-indented — including ones the user added, which is what makes a
 *  line typed at the pane's left margin land at the node's own depth. */
export function spliceSlice(fileText: string, slice: YamlSlice, edited: string): string {
  const lines = edited.split(/\r?\n/);
  const reindented = [
    lines[0],
    ...lines.slice(1).map((line) => (line.trim() === "" ? "" : slice.indent + line)),
  ].join(slice.eol);
  return (
    fileText.slice(0, slice.start) + reindented + slice.trailing + fileText.slice(slice.end)
  );
}

/** A zero-indexed line/character position, matching what a diagnostic carries. */
export interface SlicePosition {
  line: number;
  character: number;
}

export interface SliceRange {
  start: SlicePosition;
  end: SlicePosition;
}

/** Line/character of an offset in `text`. */
function positionAt(text: string, offset: number): SlicePosition {
  const before = text.slice(0, offset);
  const lastBreak = before.lastIndexOf("\n");
  return {
    line: before.split("\n").length - 1,
    character: offset - (lastBreak + 1),
  };
}

/**
 * Where a FILE range falls inside the slice, or null when it falls outside.
 *
 * Two shifts, and they differ per line: every line moves up by the slice's start
 * line, and the columns move by what was taken off the front — the slice's own
 * start column on the first line (whose leading whitespace lies before the span)
 * and the stripped indent on every line after it. Getting this wrong does not
 * fail loudly; it silently underlines the wrong text, which is worse than
 * showing nothing.
 */
export function rangeInSlice(
  fileText: string,
  slice: YamlSlice,
  range: SliceRange,
): SliceRange | null {
  const start = positionAt(fileText, slice.start);
  const lineCount = fileText.slice(slice.start, slice.end).split("\n").length;
  const lastLine = start.line + lineCount - 1;
  if (range.end.line < start.line || range.start.line > lastLine) return null;

  const shift = (position: SlicePosition): SlicePosition => {
    const line = Math.max(0, Math.min(position.line, lastLine) - start.line);
    const taken = position.line === start.line ? start.character : indentWidth(slice);
    return { line, character: Math.max(0, position.character - taken) };
  };
  return { start: shift(range.start), end: shift(range.end) };
}

function indentWidth(slice: YamlSlice): number {
  return slice.indent.length;
}

/** Finds the source span for one resource's `pointer` across the files a module
 *  spans. Undefined when the resource's document cannot be found, the file
 *  failed to parse, or the pointer names a path the source does not write. */
export function locateSlice(
  sourceFiles: ModuleSourceFile[],
  kind: string,
  name: string,
  pointer: string,
): LocatedSlice | undefined {
  for (const file of sourceFiles) {
    if (file.parseError) continue;
    const doc = findResourceDocument(file.documents, kind, name);
    if (!doc) continue;
    const node = nodeAtPointer(doc.root, pointer);
    if (!node) return undefined;
    return { filePath: file.filePath, fileText: file.text, slice: sliceOf(file.text, node) };
  }
  return undefined;
}
