/** Rendering a migration plan back into the author's YAML.
 *
 *  Edits are BYTE SPLICES computed from the parsed document's node ranges, not
 *  `Document.toString()`. That is `cli/nodejs/src/commands/upgrade.ts`'s
 *  precedent and it is load-bearing here for the same reason: re-serializing
 *  re-folds block scalars, drops quote-style hints and reflows long strings, so
 *  a one-key repair would arrive as a whole-file diff. Everything outside the
 *  spliced ranges is byte-identical to the input.
 *
 *  The document is parsed with the same `defaultCustomTags()` every other
 *  parse site uses, so a tagged scalar is a node here exactly as it is in the
 *  loader's tree. */

import { isMap, isPair, isScalar, isSeq, type Document, type Node } from "yaml";
import { renderFixReplacement, type TextEdit } from "../yaml-source-edit.js";
import type { MigrationEffect } from "./patch.js";
import type { MigrationPath } from "./types.js";

export { applyTextEdits, type TextEdit } from "../yaml-source-edit.js";

function nodeAt(doc: Document, path: MigrationPath): unknown {
  if (path.length === 0) return doc.contents;
  return doc.getIn(path as (string | number)[], true);
}

function rangeOf(node: unknown): [number, number] | undefined {
  const range = (node as { range?: unknown } | undefined)?.range;
  if (!Array.isArray(range) || typeof range[0] !== "number" || typeof range[1] !== "number") {
    return undefined;
  }
  return [range[0], range[1]];
}

/** The Pair whose key is `key` inside the map at `parent`. */
function pairAt(doc: Document, parent: MigrationPath, key: string): unknown {
  const map = nodeAt(doc, parent);
  if (!isMap(map)) return undefined;
  return map.items.find(
    (item) => isPair(item) && isScalar(item.key) && String(item.key.value) === key,
  );
}

/** Re-quote `value` in the style the author used at `original`.
 *
 *  A non-string is rendered as its YAML spelling and then handed to the shared
 *  rule, so a migration and a quick fix quote the same value identically — the
 *  rule itself is `renderFixReplacement` (`../yaml-source-edit.js`), which both
 *  this and `@telorun/ide-support` read rather than restate. */
function renderScalar(original: string, value: unknown): string | undefined {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value !== "string") return undefined;
  return renderFixReplacement(original, value);
}

/** Column of `offset` within its line, and the offset of that line's start. */
function lineGeometry(text: string, offset: number): { lineStart: number; indent: number } {
  const lineStart = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  return { lineStart, indent: offset - lineStart };
}

/** One YAML edit per effect, or `undefined` when the effect cannot be written
 *  into this file — the same all-or-nothing rule the tree side has, so a
 *  partially applied patch never reaches disk. */
export function planTextEdits(
  doc: Document,
  text: string,
  effects: readonly MigrationEffect[],
): TextEdit[] | undefined {
  if (effects.length === 0) return [];

  // **The document is never mutated.** A patch's later effects address the node
  // by its POST-rename path, which the file does not have — so every effect is
  // resolved at the one location the patch matched, read off the first effect.
  // The tree applier and this one therefore agree without either replaying the
  // other's state.
  const first = effects[0]!;
  const docPath: MigrationPath =
    first.kind === "rename-key" ? [...first.parent, first.from] : first.path;

  // A removal supersedes every other edit at the location: `planPatch` refuses
  // anything after a `remove-entry`, and the line it deletes contains them.
  const removal = effects.find((e) => e.kind === "remove-entry");
  if (removal) return removeEntryEdit(doc, text, docPath);

  const edits: TextEdit[] = [];
  let keyEdit: TextEdit | undefined;
  // Value edits compose into ONE splice: a `set-tag` after a `set-value` must
  // emit the tag in front of the NEW scalar, not re-read the old one.
  let valueSpan: [number, number] | undefined;
  let scalarText: string | undefined;
  let tagText: string | undefined;

  for (const effect of effects) {
    switch (effect.kind) {
      case "rename-key": {
        const pair = pairAt(doc, docPath.slice(0, -1), String(docPath[docPath.length - 1]));
        if (!isPair(pair) || !isScalar(pair.key)) return undefined;
        const range = rangeOf(pair.key);
        if (!range) return undefined;
        const rendered = renderScalar(text.slice(range[0], range[1]), effect.to);
        if (rendered === undefined) return undefined;
        keyEdit = { start: range[0], end: range[1], newText: rendered };
        break;
      }
      case "set-value": {
        const range = rangeOf(nodeAt(doc, docPath));
        if (!range) return undefined;
        const rendered = renderScalar(text.slice(range[0], range[1]), effect.value);
        if (rendered === undefined) return undefined;
        valueSpan ??= range;
        scalarText = rendered;
        break;
      }
      case "set-tag": {
        const node = nodeAt(doc, docPath);
        if (!isScalar(node)) return undefined;
        const range = rangeOf(node);
        if (!range) return undefined;
        // The tag sits outside the scalar's own span, so an existing one is
        // replaced by rewriting from where it starts; a plain scalar just gains
        // a prefix.
        const existing = typeof node.tag === "string" ? node.tag : undefined;
        const tagStart = existing ? text.lastIndexOf(existing, range[0]) : -1;
        valueSpan = [tagStart >= 0 ? tagStart : range[0], range[1]];
        scalarText ??= text.slice(range[0], range[1]);
        tagText = `!${effect.tag}`;
        break;
      }
      case "insert-item": {
        const edit = insertItemEdit(doc, text, docPath, effect.index, effect.value);
        if (!edit) return undefined;
        edits.push(edit);
        break;
      }
      case "remove-entry":
        // Handled above.
        break;
    }
  }

  if (keyEdit) edits.push(keyEdit);
  if (valueSpan && scalarText !== undefined) {
    edits.push({
      start: valueSpan[0],
      end: valueSpan[1],
      newText: tagText ? `${tagText} ${scalarText}` : scalarText,
    });
  }
  return edits;
}

function insertItemEdit(
  doc: Document,
  text: string,
  path: MigrationPath,
  index: number,
  value: unknown,
): TextEdit | undefined {
  const seq = nodeAt(doc, path);
  // An empty sequence is written `[]` in flow style, which has no item line to
  // extend — the one insert shape this cannot render.
  if (!isSeq(seq) || seq.items.length === 0) return undefined;
  const rendered = renderScalar("", value);
  if (rendered === undefined) return undefined;

  const anchorIndex = Math.min(index, seq.items.length - 1);
  const anchor = rangeOf(seq.items[anchorIndex] as Node);
  if (!anchor) return undefined;
  const { lineStart, indent } = lineGeometry(text, anchor[0]);
  // A block sequence's item starts two columns after its `- `; a flow sequence
  // has no line of its own.
  if (text.slice(lineStart, anchor[0]).trimStart() !== "- ") return undefined;
  const line = `${" ".repeat(Math.max(0, indent - 2))}- ${rendered}\n`;

  if (index >= seq.items.length) {
    const last = rangeOf(seq.items[seq.items.length - 1] as Node);
    if (!last) return undefined;
    const lineEnd = text.indexOf("\n", last[1]);
    const at = lineEnd < 0 ? text.length : lineEnd + 1;
    return { start: at, end: at, newText: line };
  }
  return { start: lineStart, end: lineStart, newText: line };
}

function removeEntryEdit(
  doc: Document,
  text: string,
  path: MigrationPath,
): TextEdit[] | undefined {
  const located = locateEntry(doc, path);
  if (!located) return undefined;
  const { lineStart } = lineGeometry(text, located.start);
  const prefix = text.slice(lineStart, located.start);
  const opensSequenceItem = /^-\s+$/.test(prefix.trimStart());

  // The entry OWNS its line — indentation for a mapping entry, indentation plus
  // `- ` for a sequence item — so removing the line is exact.
  if (located.item ? opensSequenceItem : prefix.trim() === "") {
    const lineEnd = text.indexOf("\n", located.end);
    return [{ start: lineStart, end: lineEnd < 0 ? text.length : lineEnd + 1, newText: "" }];
  }

  // A mapping entry that OPENS a sequence item shares its line with the `- `,
  // and is the overwhelmingly common shape of the one thing a migration removes
  // today: a legacy ref slot is almost always an `anyOf` branch, written
  // `- type: string` with the annotation beneath it. Deleting the line would
  // take the dash with it and fold the item into its predecessor — so the entry
  // is spliced out up to the FOLLOWING sibling's key instead, which slides onto
  // the dash at the column it already occupies. Refusing here would have made
  // the diagnostic's own advice ("run `telo migrate`") dead for the case it is
  // most often given in.
  if (!located.item && opensSequenceItem) {
    const next = nextSiblingKeyStart(doc, path);
    // Nothing to promote onto the dash: the entry is the item's only one, and
    // removing it would leave `- ` with no value.
    if (next === undefined) return undefined;
    // Only whitespace may be swallowed. A comment or anything else between the
    // two entries would be destroyed by the splice, so that stays a hand edit.
    const between = text.slice(located.end, next);
    if (!/^\s*$/.test(between) || !between.includes("\n")) return undefined;
    return [{ start: located.start, end: next, newText: "" }];
  }
  return undefined;
}

/** Offset of the key of the entry FOLLOWING `path` in its own mapping, or
 *  `undefined` when `path` is the last entry (or anything is not a plain
 *  key-scalar pair). */
function nextSiblingKeyStart(doc: Document, path: MigrationPath): number | undefined {
  const map = nodeAt(doc, path.slice(0, -1));
  if (!isMap(map)) return undefined;
  const key = String(path[path.length - 1]);
  const at = map.items.findIndex(
    (item) => isPair(item) && isScalar(item.key) && String(item.key.value) === key,
  );
  if (at < 0) return undefined;
  const next = map.items[at + 1];
  if (!isPair(next) || !isScalar(next.key)) return undefined;
  return rangeOf(next.key)?.[0];
}

/** Span of a whole mapping entry (key through value) or sequence item. */
function locateEntry(
  doc: Document,
  path: MigrationPath,
): { start: number; end: number; item: boolean } | undefined {
  const last = path[path.length - 1];
  if (typeof last === "string") {
    const pair = pairAt(doc, path.slice(0, -1), last);
    if (!isPair(pair) || !isScalar(pair.key)) return undefined;
    const keyRange = rangeOf(pair.key);
    const valueRange = rangeOf(pair.value) ?? keyRange;
    if (!keyRange || !valueRange) return undefined;
    return { start: keyRange[0], end: valueRange[1], item: false };
  }
  const range = rangeOf(nodeAt(doc, path));
  if (!range) return undefined;
  return { start: range[0], end: range[1], item: true };
}
