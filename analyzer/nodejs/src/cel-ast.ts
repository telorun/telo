import { ParseError, parse, type ASTNode as CelJsNode } from "@marcbachmann/cel-js";
import { defaultRegistry, readInterpolationHoles } from "@telorun/templating";
import { scalarRawOffsets } from "./scalar-offsets.js";

/** A CEL body that does not parse — an author's expression, mid-typing or
 *  malformed. Owned here so a consumer can be lenient about author syntax
 *  (navigation, completion) without also swallowing a defect in the wrapper
 *  below, and so the third-party parser's error type stays internal, exactly as
 *  its AST type does. */
export class CelParseError extends Error {
  constructor(
    readonly source: string,
    override readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "CelParseError";
  }
}

/** Parse a CEL body, translating the parser's own failure into `CelParseError`.
 *  Anything else (a bug in `wrapCelAst`) propagates untouched. */
function parseCel(source: string): CelJsNode {
  try {
    return parse(source).ast;
  } catch (error) {
    if (error instanceof ParseError) throw new CelParseError(source, error);
    throw error;
  }
}

/** Read-only CEL expression tree owned by the analyzer. The third-party
 *  `@marcbachmann/cel-js` `ASTNode` stays an internal detail — `wrapCelAst`
 *  translates it into this union so no external AST type leaks through the
 *  public surface (full symmetry with the YAML `AstNode` decision). Every
 *  `range` is `[start, end]` in DOCUMENT offsets. */
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

const BINARY_OPS = new Set([
  "!=",
  "==",
  "in",
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  "<=",
  ">",
  ">=",
  "||",
  "&&",
]);

/** Where an offset into a CEL body lands in the document: the body's start
 *  added to it, or a mapping through the scalar's own escapes. */
export type CelOffsetMap = number | ((offset: number) => number);

/** Maps a `@marcbachmann/cel-js` node into the analyzer `CelNode`, translating
 *  each node's segment-relative `start`/`end` to absolute document offsets
 *  through `segmentStart`. */
export function wrapCelAst(node: CelJsNode, segmentStart: CelOffsetMap): CelNode {
  const range = abs(node, segmentStart);
  const op = node.op;
  const args = node.args as unknown;

  if (op === "value") return { kind: "literal", range, value: args };
  if (op === "id") return { kind: "ident", range, name: String(args) };
  if (op === "." || op === ".?") {
    const [target, property] = args as [CelJsNode, string];
    return {
      kind: "member",
      range,
      target: wrapCelAst(target, segmentStart),
      property,
      propertyRange: [range[1] - property.length, range[1]],
      optional: op === ".?",
    };
  }
  if (op === "[]" || op === "[?]") {
    const [target, index] = args as [CelJsNode, CelJsNode];
    return {
      kind: "index",
      range,
      target: wrapCelAst(target, segmentStart),
      index: wrapCelAst(index, segmentStart),
      optional: op === "[?]",
    };
  }
  if (op === "call") {
    const [name, callArgs] = args as [string, CelJsNode[]];
    return { kind: "call", range, name, args: callArgs.map((a) => wrapCelAst(a, segmentStart)) };
  }
  if (op === "rcall") {
    const [name, receiver, callArgs] = args as [string, CelJsNode, CelJsNode[]];
    return {
      kind: "methodCall",
      range,
      name,
      receiver: wrapCelAst(receiver, segmentStart),
      args: callArgs.map((a) => wrapCelAst(a, segmentStart)),
    };
  }
  if (op === "list") {
    return { kind: "list", range, items: (args as CelJsNode[]).map((a) => wrapCelAst(a, segmentStart)) };
  }
  if (op === "map") {
    return {
      kind: "map",
      range,
      entries: (args as [CelJsNode, CelJsNode][]).map(([k, v]) => ({
        key: wrapCelAst(k, segmentStart),
        value: wrapCelAst(v, segmentStart),
      })),
    };
  }
  if (op === "?:") {
    const [cond, then, els] = args as [CelJsNode, CelJsNode, CelJsNode];
    return {
      kind: "ternary",
      range,
      cond: wrapCelAst(cond, segmentStart),
      then: wrapCelAst(then, segmentStart),
      else: wrapCelAst(els, segmentStart),
    };
  }
  if (op === "!_" || op === "-_") {
    return { kind: "unary", range, op, operand: wrapCelAst(args as CelJsNode, segmentStart) };
  }
  if (BINARY_OPS.has(op)) {
    const [left, right] = args as [CelJsNode, CelJsNode];
    return {
      kind: "binary",
      range,
      op,
      left: wrapCelAst(left, segmentStart),
      right: wrapCelAst(right, segmentStart),
    };
  }
  // Unknown operator — surface it as a literal so consumers can still hit-test
  // the range rather than crash on an unmapped node.
  return { kind: "literal", range, value: undefined };
}

function abs(node: CelJsNode, segmentStart: CelOffsetMap): [number, number] {
  const r = node.range ?? { start: node.start, end: node.end };
  const at = typeof segmentStart === "number" ? (o: number) => o + segmentStart : segmentStart;
  return [at(r.start), at(r.end)];
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
