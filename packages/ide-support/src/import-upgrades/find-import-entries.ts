import {
  foldIntegrity,
  isModuleKind,
  offsetToPosition,
  type AstDocument,
  type AstMap,
  type AstNode,
  type Range,
} from "@telorun/analyzer";

/** One `imports:` map entry, located in the source text.
 *
 *  `source` is the *folded* form — an object-form `integrity:` sibling is
 *  folded into the source string as a `#sha256-…` fragment, exactly as
 *  `inlineImportManifests` does, so callers reason about a single
 *  representation regardless of which shape the author wrote. */
export interface ImportEntry {
  alias: string;
  /** The source with any `integrity:` sibling folded in as a fragment. */
  source: string;
  /** Span of the alias key — where a per-entry affordance anchors. */
  keyRange: Range;
  /** Span of the source scalar's value: the entry value itself for the scalar
   *  shorthand, the `source:` value for the object form. Replacing this span
   *  re-points the import. */
  sourceRange: Range;
  /** Where an object-form `integrity:` sibling sits, when the entry declares
   *  one. Absent for the scalar shorthand — there the pin rides inside
   *  `sourceRange` as a `#sha256-…` fragment — and for an unpinned entry. */
  integrity?: ImportEntryIntegrity;
}

/** The two spans a caller needs to act on an object-form `integrity:`: one to
 *  re-pin it, one to remove it. They are separate because a flow-style map
 *  (`{source: …, integrity: …}`) supports the first and not the second. */
export interface ImportEntryIntegrity {
  /** Span of the hash value itself. Replacing it re-pins the entry in the shape
   *  the author wrote, in any YAML style. */
  valueRange: Range;
  /** Whole-line span of the `integrity:` entry including its trailing newline,
   *  so a caller with no replacement hash can delete the line outright. Absent
   *  when the pair shares a line with other content, where removing it would
   *  need a structural rewrite rather than a line splice. */
  lineRange?: Range;
}

/** Where the `imports:` map lives in a module document. */
export interface ImportsBlock {
  /** Span of the `imports:` key — where a summary affordance anchors. */
  keyRange: Range;
  entries: ImportEntry[];
}

/** Locate the `imports:` map of the file's module document (`Telo.Application`
 *  / `Telo.Library`). Returns `undefined` when the file declares no module doc
 *  or the doc has no `imports:` map — a partial file, or a module with no
 *  dependencies.
 *
 *  Reads the AST rather than the analyzer's flattened manifests because the
 *  affordances built on top of this write back to the source: the exact span of
 *  each source scalar is the deliverable, not the resolved value. */
export function findImportEntries(
  text: string,
  docs: AstDocument[],
  lineOffsets: number[],
): ImportsBlock | undefined {
  for (const doc of docs) {
    const root = doc.root;
    if (!root || root.kind !== "map") continue;
    if (!isModuleKind(scalarString(mapGet(root, "kind")))) continue;

    const importsPair = root.entries.find(
      (p) => p.key.kind === "scalar" && p.key.value === "imports",
    );
    if (!importsPair?.value || importsPair.value.kind !== "map") return undefined;

    return {
      keyRange: toRange(importsPair.key, lineOffsets),
      entries: importsPair.value.entries.flatMap((pair) => {
        const alias = scalarString(pair.key);
        if (alias === undefined || !pair.value) return [];
        const entry = readEntry(alias, pair.key, pair.value, text, lineOffsets);
        return entry ? [entry] : [];
      }),
    };
  }
  return undefined;
}

/** Read one entry in either authored shape. Returns `undefined` for a malformed
 *  entry (an object with no string `source:`) — the module document's own
 *  schema validation already reports those against `imports.<Alias>.source`. */
function readEntry(
  alias: string,
  keyNode: AstNode,
  valueNode: AstNode,
  text: string,
  lineOffsets: number[],
): ImportEntry | undefined {
  const keyRange = toRange(keyNode, lineOffsets);

  if (valueNode.kind === "scalar") {
    const source = scalarString(valueNode);
    if (source === undefined) return undefined;
    return { alias, source, keyRange, sourceRange: toRange(valueNode, lineOffsets) };
  }

  if (valueNode.kind !== "map") return undefined;
  const sourceNode = mapGet(valueNode, "source");
  const source = scalarString(sourceNode);
  if (sourceNode === undefined || source === undefined) return undefined;

  const integrityPair = valueNode.entries.find(
    (p) => p.key.kind === "scalar" && p.key.value === "integrity",
  );
  const integrity = scalarString(integrityPair?.value);

  const entry: ImportEntry = {
    alias,
    source: foldIntegrity(source, integrity),
    keyRange,
    sourceRange: toRange(sourceNode, lineOffsets),
  };

  if (integrityPair?.value && integrity !== undefined) {
    entry.integrity = {
      valueRange: toRange(integrityPair.value, lineOffsets),
      lineRange: wholeLineSpan(
        integrityPair.key.range[0],
        integrityPair.value.range[1],
        text,
        lineOffsets,
      ),
    };
  }

  return entry;
}

/** The whole-lines span covering `[start, end)` plus its trailing newline, or
 *  `undefined` when the span shares a line with other content — only leading
 *  indentation may precede it and nothing but spacing may follow. A flow-style
 *  map (`{source: …, integrity: …}`) fails this test, which is what keeps a
 *  line splice from eating a sibling field. */
function wholeLineSpan(
  start: number,
  end: number,
  text: string,
  lineOffsets: number[],
): Range | undefined {
  const lineStart = lineOffsets[offsetToPosition(start, lineOffsets).line];
  if (text.slice(lineStart, start).trim() !== "") return undefined;

  const nextNewline = text.indexOf("\n", end);
  const lineEnd = nextNewline === -1 ? text.length : nextNewline + 1;
  if (text.slice(end, nextNewline === -1 ? text.length : nextNewline).trim() !== "") {
    return undefined;
  }

  return {
    start: offsetToPosition(lineStart, lineOffsets),
    end: offsetToPosition(lineEnd, lineOffsets),
  };
}

function toRange(node: AstNode, lineOffsets: number[]): Range {
  return {
    start: offsetToPosition(node.range[0], lineOffsets),
    end: offsetToPosition(node.range[1], lineOffsets),
  };
}

function mapGet(node: AstMap, key: string): AstNode | undefined {
  return node.entries.find((p) => p.key.kind === "scalar" && p.key.value === key)?.value;
}

/** The node's value when it is a plain (untagged) string scalar. A `!cel` /
 *  `!ref` scalar resolves to a sentinel object, not a string, so it falls out
 *  here — an import source is never an expression. */
function scalarString(node: AstNode | undefined): string | undefined {
  if (!node || node.kind !== "scalar") return undefined;
  return typeof node.value === "string" ? node.value : undefined;
}
