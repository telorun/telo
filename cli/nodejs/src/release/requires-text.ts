/**
 * Text edits of a module manifest's `requires.telo` and of the bounds inside its
 * `restrictions:` entries — spliced into the source, so layout, comments and
 * every other byte are kept (the posture of the other release writers).
 *
 * Two callers: `telo release floor` writes the measured floor, and floor
 * measurement builds the copy it runs the published CLI over.
 */

import { applyTextEdits, isModuleKind, type TextEdit } from "@telorun/analyzer";
import { defaultCustomTags } from "@telorun/templating";
import {
  isMap,
  isScalar,
  isSeq,
  parseAllDocuments,
  type Document,
  type Pair,
  type YAMLMap,
} from "yaml";

/** The bound a host axis, or a `telo` bound with no candidate, is replaced by in
 *  a measurement copy: every runtime meets it. */
export const ANY_RUNTIME_BOUND = ">=0.0.0";

export interface FloorEdit {
  text: string;
  /** 0-based line before which lines were added or removed, and how many net
   *  lines — so a line reported against the edited text maps back. */
  atLine: number;
  delta: number;
}

interface ModuleMap {
  doc: Document;
  map: YAMLMap;
}

function moduleMap(text: string): ModuleMap {
  for (const doc of parseAllDocuments(text, { customTags: defaultCustomTags })) {
    const kind = doc.get("kind");
    if (typeof kind === "string" && isModuleKind(kind) && isMap(doc.contents)) {
      return { doc, map: doc.contents };
    }
  }
  throw new Error("the manifest holds no Telo.Application or Telo.Library document");
}

function pairOf(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((p) => isScalar(p.key) && p.key.value === key) as Pair | undefined;
}

function rangeOf(node: unknown): [number, number, number] | undefined {
  const range = (node as { range?: [number, number, number] } | null | undefined)?.range;
  return range;
}

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf("\n", offset - 1) + 1;
}

/** Offset just past the newline ending the line holding `offset` (the text's end
 *  when it is the last line). */
function afterLine(text: string, offset: number): number {
  if (offset > 0 && text[offset - 1] === "\n") return offset;
  const at = text.indexOf("\n", offset);
  return at === -1 ? text.length : at + 1;
}

function lineOf(text: string, offset: number): number {
  let line = 0;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

function lineCount(text: string): number {
  return text.split("\n").length;
}

/** `value` written in the quote style of the scalar it replaces. */
function quoted(original: string, value: string): string {
  return original.startsWith("'") ? `'${value}'` : `"${value}"`;
}

function finish(text: string, edits: TextEdit[]): FloorEdit {
  const next = applyTextEdits(text, edits);
  const first = Math.min(...edits.map((e) => e.start));
  return {
    text: next,
    atLine: lineOf(text, first),
    delta: lineCount(next) - lineCount(text),
  };
}

/**
 * The manifest with `requires.telo` set to `>=<floor>`, or removed when `floor`
 * is `null`. A `requires:` block left holding nothing is removed with it.
 * Returns the text unchanged (delta 0) when there is nothing to do.
 */
export function writeFloor(text: string, floor: string | null): FloorEdit {
  const unchanged: FloorEdit = { text, atLine: 0, delta: 0 };
  const { map } = moduleMap(text);
  const requires = pairOf(map, "requires");

  if (requires === undefined) {
    if (floor === null) return unchanged;
    return insertRequiresBlock(text, map, floor);
  }
  const block = requires.value;
  if (!isMap(block)) {
    throw new Error(
      "'requires:' is not a mapping, so its floor cannot be written; fix the block first",
    );
  }
  const telo = pairOf(block, "telo");

  if (floor !== null) {
    if (telo) {
      const range = rangeOf(telo.value);
      if (!range) throw new Error("requires.telo has no source range");
      const original = text.slice(range[0], range[1]);
      return finish(text, [
        { start: range[0], end: range[1], newText: quoted(original, `>=${floor}`) },
      ]);
    }
    return insertTeloPair(text, block, floor);
  }

  if (!telo) return unchanged;
  if (block.items.length === 1) return removePair(text, requires, map);
  return removePair(text, telo, block);
}

function insertRequiresBlock(text: string, map: YAMLMap, floor: string): FloorEdit {
  const anchor = pairOf(map, "metadata") ?? pairOf(map, "kind");
  const range = rangeOf(anchor?.value);
  if (!anchor || !range) throw new Error("the module document has no metadata to place requires: after");
  const keyRange = rangeOf(anchor.key);
  const indent = " ".repeat((keyRange?.[0] ?? 0) - lineStart(text, keyRange?.[0] ?? 0));
  const at = afterLine(text, range[1]);
  const block = `${indent}requires: { telo: "${`>=${floor}`}" }\n`;
  const insertion = at === text.length && !text.endsWith("\n") ? `\n${block}` : block;
  return finish(text, [{ start: at, end: at, newText: insertion }]);
}

function insertTeloPair(text: string, block: YAMLMap, floor: string): FloorEdit {
  const value = `"${`>=${floor}`}"`;
  const blockRange = rangeOf(block);
  if (block.flow) {
    if (block.items.length === 0) {
      if (!blockRange) throw new Error("requires has no source range");
      return finish(text, [
        { start: blockRange[0], end: blockRange[1], newText: `{ telo: ${value} }` },
      ]);
    }
    const first = rangeOf(block.items[0]!.key);
    if (!first) throw new Error("requires has no source range");
    return finish(text, [{ start: first[0], end: first[0], newText: `telo: ${value}, ` }]);
  }
  const first = rangeOf(block.items[0]?.key);
  if (!first) throw new Error("requires has no entries to place telo: before");
  const start = lineStart(text, first[0]);
  const indent = " ".repeat(first[0] - start);
  return finish(text, [{ start, end: start, newText: `${indent}telo: ${value}\n` }]);
}

/** Remove `pair` from `parent`, whole lines in a block mapping. */
function removePair(text: string, pair: Pair, parent: YAMLMap): FloorEdit {
  const key = rangeOf(pair.key);
  const value = rangeOf(pair.value);
  if (!key || !value) throw new Error("a requires entry has no source range");
  if (!parent.flow) {
    return finish(text, [
      { start: lineStart(text, key[0]), end: afterLine(text, value[1]), newText: "" },
    ]);
  }
  const index = parent.items.indexOf(pair);
  const next = parent.items[index + 1];
  if (next) {
    const nextKey = rangeOf(next.key);
    if (!nextKey) throw new Error("a requires entry has no source range");
    return finish(text, [{ start: key[0], end: nextKey[0], newText: "" }]);
  }
  const previous = rangeOf(parent.items[index - 1]?.value);
  if (!previous) throw new Error("a requires entry has no source range");
  return finish(text, [{ start: previous[1], end: value[1], newText: "" }]);
}

/**
 * The manifest as it is measured: `requires.telo` the candidate floor (absent
 * for `null`), and every bound inside a `restrictions:` entry replaced by one
 * the measuring process meets — each `telo` bound by the candidate floor, each
 * host bound by `>=0.0.0` — while every key of every entry stays, so syntax
 * inside an entry still counts.
 */
export function measurementCopy(text: string, candidate: string | null): FloorEdit {
  const floored = writeFloor(text, candidate);
  const { map } = moduleMap(floored.text);
  const restrictions = pairOf(map, "restrictions")?.value;
  const edits: TextEdit[] = [];
  const teloBound = candidate === null ? ANY_RUNTIME_BOUND : `>=${candidate}`;

  const replaceScalar = (node: unknown, bound: string): void => {
    const range = rangeOf(node);
    if (!range || !isScalar(node)) return;
    edits.push({
      start: range[0],
      end: range[1],
      newText: quoted(floored.text.slice(range[0], range[1]), bound),
    });
  };

  if (isSeq(restrictions)) {
    for (const entry of restrictions.items) {
      if (!isMap(entry)) continue;
      const requires = pairOf(entry, "requires")?.value;
      if (!isMap(requires)) continue;
      replaceScalar(pairOf(requires, "telo")?.value, teloBound);
      const host = pairOf(requires, "host")?.value;
      if (!isMap(host)) continue;
      for (const axis of host.items) replaceScalar(axis.value, ANY_RUNTIME_BOUND);
    }
  }
  return { text: applyTextEdits(floored.text, edits), atLine: floored.atLine, delta: floored.delta };
}
