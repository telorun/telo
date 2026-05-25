import { isMap, isPair, isScalar, isSeq, type Document } from "yaml";
import type { Position, PositionIndex } from "./types.js";

/** Single source of truth for "given the source text of a multi-document YAML
 *  file, where does each document start, and what is the byte→(line,char)
 *  table for the file." Both the analyzer's `Loader` and editor frontends
 *  feed the same parsed `yaml.Document[]` through this so diagnostics
 *  resolved against `positionIndex` / `sourceLine` line up identically
 *  across hosts. */

/** Per-document position metadata used by `normalizeDiagnostic`'s fallback chain. */
export interface DocumentPosition {
  sourceLine: number;
  positionIndex: PositionIndex;
}

/** Builds DocumentPosition entries aligned to `parsedDocs[i]`. */
export function buildDocumentPositions(
  text: string,
  parsedDocs: Document[],
): DocumentPosition[] {
  const docOffsets = documentLineOffsets(text);
  const lineOffsets = buildLineOffsets(text);
  return parsedDocs.map((doc, i) => ({
    sourceLine: docOffsets[i] ?? 0,
    positionIndex: buildPositionIndex(doc, lineOffsets),
  }));
}

/** Line numbers (0-indexed) where each YAML document in a multi-doc file
 *  starts. The first document is always at line 0; subsequent entries point
 *  to the line after each `---` separator.
 *
 *  A `---` at line 0 is the doc-start marker for doc 0 (the parser still
 *  emits a single document), not a separator before an empty doc — skipping
 *  it keeps `offsets.length === parsedDocs.length` so diagnostics for doc N
 *  don't land inside doc N-1's text. */
export function documentLineOffsets(text: string): number[] {
  const offsets = [0];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trimEnd();
    if (t === "---" || t.startsWith("--- ")) {
      if (i === 0) continue;
      offsets.push(i + 1);
    }
  }
  return offsets;
}

/** Byte-offset → start-of-line lookup table. Index `i` is the byte offset of
 *  the first character on line `i`. Used with `offsetToPosition` to turn a
 *  yaml-AST node range into Range coordinates. */
export function buildLineOffsets(text: string): number[] {
  const offsets: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

function offsetToPosition(offset: number, lineOffsets: number[]): Position {
  let lo = 0;
  let hi = lineOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineOffsets[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, character: offset - lineOffsets[lo] };
}

/** Walks the YAML AST and records source ranges for every field value, keyed
 *  by dotted path (e.g. "kind", "config.handler", "config.routes[0].path").
 *  Map keys are also recorded under the `@key:<path>` namespace so diagnostic
 *  resolvers can squiggle just the key identifier instead of the full value
 *  block — used when a diagnostic targets a missing child property and the
 *  resolver has to fall back to the parent. */
export function buildPositionIndex(doc: Document, lineOffsets: number[]): PositionIndex {
  const index: PositionIndex = new Map();

  function recordNode(node: any, path: string): void {
    if (!node || !node.range) return;
    const [start, , end] = node.range as [number, number, number];
    index.set(path, {
      start: offsetToPosition(start, lineOffsets),
      end: offsetToPosition(end, lineOffsets),
    });
  }

  function walk(node: any, path: string): void {
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isPair(pair)) continue;
        const key = isScalar(pair.key) ? String(pair.key.value) : null;
        if (key == null) continue;
        const childPath = path ? `${path}.${key}` : key;
        if (pair.key && (pair.key as any).range) {
          recordNode(pair.key, `@key:${childPath}`);
        }
        if (pair.value != null) {
          recordNode(pair.value, childPath);
          walk(pair.value, childPath);
        }
      }
    } else if (isSeq(node)) {
      for (let i = 0; i < node.items.length; i++) {
        const item = node.items[i];
        const childPath = `${path}[${i}]`;
        recordNode(item, childPath);
        walk(item, childPath);
      }
    }
  }

  if (doc.contents) {
    walk(doc.contents, "");
  }

  return index;
}
