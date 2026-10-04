import { parseExpression, type CelNode as EngineNode } from "@telorun/cel";
import { defaultRegistry, readInterpolationHoles } from "@telorun/templating";
import { scalarRawOffsets } from "./scalar-offsets.js";

/** A CEL body that does not parse — an author's expression, mid-typing or
 *  malformed. Owned here so a consumer can be lenient about author syntax
 *  (navigation, completion) without also swallowing a defect in the wrapper
 *  below, and so the engine's own diagnostic stays internal, exactly as its
 *  tree type does. */
export class CelParseError extends Error {
  constructor(
    readonly source: string,
    override readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "CelParseError";
  }
}

/** Parse a CEL body, turning the engine's syntax diagnostic into
 *  `CelParseError`. Reading never throws, so the diagnostic is what says the
 *  tree is incomplete; anything thrown here is a defect and propagates. */
function parseCel(source: string): EngineNode {
  const parsed = parseExpression(source);
  const diagnostic = parsed.diagnostics[0];
  if (diagnostic) throw new CelParseError(source, new Error(diagnostic.message));
  return parsed.root;
}

/** Read-only CEL expression tree owned by the analyzer. The engine's own
 *  `CelNode` stays an internal detail — `wrapCelAst` translates it into this
 *  union so no external tree type leaks through the public surface (full
 *  symmetry with the YAML `AstNode` decision). Every `range` is
 *  `[start, end]` in DOCUMENT offsets. */
export type CelNode =
  | { kind: "literal"; range: [number, number]; value: unknown }
  | { kind: "ident"; range: [number, number]; name: string }
  | {
      kind: "member";
      range: [number, number];
      target: CelNode;
      property: string;
      /** Span of just the `.prop` identifier, for a future rename. */
      propertyRange: [number, number];
      /** `.?` optional member access. */
      optional: boolean;
    }
  | {
      kind: "index";
      range: [number, number];
      target: CelNode;
      index: CelNode;
      /** `[?]` optional index. */
      optional: boolean;
    }
  | { kind: "call"; range: [number, number]; name: string; args: CelNode[] }
  | {
      kind: "methodCall";
      range: [number, number];
      name: string;
      receiver: CelNode;
      args: CelNode[];
    }
  | { kind: "list"; range: [number, number]; items: CelNode[] }
  | { kind: "map"; range: [number, number]; entries: { key: CelNode; value: CelNode }[] }
  | {
      kind: "ternary";
      range: [number, number];
      cond: CelNode;
      then: CelNode;
      else: CelNode;
    }
  | { kind: "unary"; range: [number, number]; op: string; operand: CelNode }
  | { kind: "binary"; range: [number, number]; op: string; left: CelNode; right: CelNode };

/** A CEL expression inside a tagged YAML scalar — a `!cel` body or one hole of
 *  a tag with holes. Ranges are DOCUMENT offsets; `source` is the CEL body (a
 *  longest-valid prefix when `open`).
 *  `ast()` parses lazily — nothing parses CEL during `parseToAst`, only the
 *  expression a caller actually inspects. */
export interface CelSegment {
  /** Segment span in document offsets — the expression, or from an unclosed
   *  hole's `${{` to its line's end. */
  range: [number, number];
  /** The CEL body (a prefix when `open`). */
  source: string;
  /** True when a `${{` has no matching `}}` yet (the user is mid-typing). */
  open: boolean;
  /** Lazily parse + wrap; ranges are already absolute. Throws `CelParseError`
   *  when the body doesn't parse — an `open` segment recovers to its longest
   *  parseable prefix instead, so only a closed one can throw. */
  ast(): CelNode;
}

/** Where an offset into a CEL body lands in the document: the body's start
 *  added to it, or a mapping through the scalar's own escapes. */
export type CelOffsetMap = number | ((offset: number) => number);

/** Maps an engine `CelNode` into the analyzer `CelNode`, translating each
 *  node's segment-relative range to absolute document offsets through
 *  `segmentStart`. */
export function wrapCelAst(node: EngineNode, segmentStart: CelOffsetMap): CelNode {
  const range = abs(node.range, segmentStart);
  const wrap = (child: EngineNode) => wrapCelAst(child, segmentStart);

  switch (node.kind) {
    case "literal":
      // A `null` literal carries no value of its own; it is spelled as the
      // value it denotes so a consumer reading `value` sees what was written.
      return {
        kind: "literal",
        range,
        value: node.literal.type === "null" ? null : node.literal.value,
      };
    case "ident":
      return { kind: "ident", range, name: node.name };
    case "select":
      // `fieldRange` is the engine's own span for the member name, so a rename
      // edits the right text through `.?field` and a backtick-quoted name
      // alike — both of which a length subtracted from the node's end missed.
      return {
        kind: "member",
        range,
        target: wrap(node.operand),
        property: node.field,
        propertyRange: abs(node.fieldRange, segmentStart),
        optional: node.optional,
      };
    case "index":
      return {
        kind: "index",
        range,
        target: wrap(node.operand),
        index: wrap(node.index),
        optional: node.optional,
      };
    case "call":
      return { kind: "call", range, name: node.name, args: node.args.map(wrap) };
    case "receiverCall":
      return {
        kind: "methodCall",
        range,
        name: node.name,
        receiver: wrap(node.receiver),
        args: node.args.map(wrap),
      };
    case "qcall":
      // A call on a name that denotes a MODULE. The segments a scalar yields
      // are read with no namespace set, so one reaches here only if a caller
      // wraps a tree resolved elsewhere; it reads as the method call its
      // source text is.
      return {
        kind: "methodCall",
        range,
        name: node.name,
        receiver: {
          kind: "ident",
          range: abs(node.namespaceRange, segmentStart),
          name: node.namespace,
        },
        args: node.args.map(wrap),
      };
    case "list":
      return { kind: "list", range, items: node.elements.map((element) => wrap(element.value)) };
    case "map":
      return {
        kind: "map",
        range,
        entries: node.entries.map((entry) => ({ key: wrap(entry.key), value: wrap(entry.value) })),
      };
    case "conditional":
      return {
        kind: "ternary",
        range,
        cond: wrap(node.condition),
        then: wrap(node.whenTrue),
        else: wrap(node.whenFalse),
      };
    case "unary":
      return { kind: "unary", range, op: node.operator, operand: wrap(node.operand) };
    case "binary":
      return {
        kind: "binary",
        range,
        op: node.operator,
        left: wrap(node.left),
        right: wrap(node.right),
      };
    case "unparsed":
      // The hole error recovery leaves where no expression could be read.
      // Surfaced as a literal so consumers can still hit-test the range rather
      // than crash on an unmapped node.
      return { kind: "literal", range, value: undefined };
  }
}

function abs(
  nodeRange: readonly [number, number],
  segmentStart: CelOffsetMap,
): [number, number] {
  const at = typeof segmentStart === "number" ? (o: number) => o + segmentStart : segmentStart;
  return [at(nodeRange[0]), at(nodeRange[1])];
}

/** Parse `source` and wrap it, tolerating a trailing partial member/index
 *  access (`req.`, `req.fo`) by falling back to the longest parseable prefix.
 *  Used for `open` segments where completion fires mid-token. */
function parseLenient(
  source: string,
  segmentStart: CelOffsetMap,
  range: [number, number],
): CelNode {
  const candidates = [source, source.replace(/[.?[]+\w*$/, ""), source.replace(/[.?[(]+.*$/, "")];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) break;
    try {
      return wrapCelAst(parseCel(trimmed), segmentStart);
    } catch (error) {
      // Only a body that doesn't parse warrants the next-shorter prefix; a
      // wrapper defect is not something a shorter prefix fixes.
      if (!(error instanceof CelParseError)) throw error;
    }
  }
  return { kind: "ident", range, name: source.trim() };
}

/** Build the CEL segments of a scalar from its raw source slice. `scalarText`
 *  is `text.slice(start, valueEnd)` and `scalarStart` its document offset.
 *
 *  The tag's engine says where its CEL sits (`expressionRegions`): one segment
 *  spanning a `!cel` body, one per hole of a tag with holes. A plain scalar has
 *  none. A tag whose holes cannot be read yet — a `${{` the author is still
 *  typing — yields the holes before it plus a trailing `open` segment, bounded
 *  to its line, so completion still has the region the cursor is in. */
export function buildCelSegments(
  scalarText: string,
  scalarStart: number,
  tag: string | undefined,
  taggedSource: string | undefined,
  style?: string,
): CelSegment[] {
  if (!tag?.startsWith("!") || taggedSource == null) return [];
  const engine = defaultRegistry().get(tag.slice(1));
  if (!engine?.expressionRegions) return [];
  // Offsets into the parsed source mapped through the scalar's own escapes and
  // indentation; where the style has no character-for-character image, the
  // source's first occurrence in the text stands in for its start.
  const rawOffsets = scalarRawOffsets(scalarText, style, taggedSource);
  const idx = scalarText.indexOf(taggedSource);
  const docAt = rawOffsets
    ? (offset: number) => scalarStart + rawOffsets[offset]!
    : (offset: number) => scalarStart + (idx >= 0 ? idx : 0) + offset;
  const within = (start: number) => (offset: number) => docAt(start + offset);
  const closed = (start: number, end: number): CelSegment => {
    const source = taggedSource.slice(start, end);
    return {
      range: [docAt(start), docAt(end)],
      source,
      open: false,
      ast: () => wrapCelAst(parseCel(source), within(start)),
    };
  };

  const regions = engine.expressionRegions(taggedSource);
  const reading = regions.length === 0 ? readInterpolationHoles(taggedSource) : undefined;
  if (!reading || reading.ok) return regions.map((r) => closed(r.start, r.end));

  const before = readInterpolationHoles(taggedSource.slice(0, reading.offset));
  const segments = before.ok ? before.holes.map((h) => closed(h.exprStart, h.exprStart + h.expr.length)) : [];
  const after = reading.offset + OPEN_MARKER.length;
  let lineEnd = taggedSource.indexOf("\n", after);
  if (lineEnd < 0) lineEnd = taggedSource.length;
  const rawBody = taggedSource.slice(after, lineEnd);
  const leadingWs = rawBody.match(/^\s*/)?.[0].length ?? 0;
  const source = rawBody.trim();
  const range: [number, number] = [docAt(reading.offset), docAt(lineEnd)];
  segments.push({
    range,
    source,
    open: true,
    ast: () => parseLenient(source, within(after + leadingWs), range),
  });
  return segments;
}

const OPEN_MARKER = "${{";
