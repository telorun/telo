import { parse, type ASTNode as CelJsNode } from "@marcbachmann/cel-js";

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

/** A `${{ }}` / `!cel` region inside a YAML scalar. Ranges are DOCUMENT
 *  offsets; `source` is the CEL body (a longest-valid prefix when `open`).
 *  `ast()` parses lazily — nothing parses CEL during `parseToAst`, only the
 *  expression a caller actually inspects. */
export interface CelSegment {
  /** Segment span in document offsets (includes the `${{ }}` for interpolation). */
  range: [number, number];
  /** The CEL body (a prefix when `open`). */
  source: string;
  /** True when a `${{` has no matching `}}` yet (the user is mid-typing). */
  open: boolean;
  /** Lazily parse + wrap; ranges are already absolute. */
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

/** Maps a `@marcbachmann/cel-js` node into the analyzer `CelNode`, translating
 *  each node's segment-relative `start`/`end` to absolute document offsets by
 *  adding `segmentStart`. */
export function wrapCelAst(node: CelJsNode, segmentStart: number): CelNode {
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

function abs(node: CelJsNode, segmentStart: number): [number, number] {
  const r = node.range ?? { start: node.start, end: node.end };
  return [r.start + segmentStart, r.end + segmentStart];
}

/** Parse `source` and wrap it, tolerating a trailing partial member/index
 *  access (`req.`, `req.fo`) by falling back to the longest parseable prefix.
 *  Used for `open` segments where completion fires mid-token. */
function parseLenient(source: string, segmentStart: number, range: [number, number]): CelNode {
  const candidates = [source, source.replace(/[.?[]+\w*$/, ""), source.replace(/[.?[(]+.*$/, "")];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) break;
    try {
      return wrapCelAst(parse(trimmed).ast, segmentStart);
    } catch {
      // try the next-shorter prefix
    }
  }
  return { kind: "ident", range, name: source.trim() };
}

const OPEN_MARKER = "${{";

/** Build the CEL segments of a scalar from its raw source slice. `scalarText`
 *  is `text.slice(start, valueEnd)` and `scalarStart` its document offset.
 *
 *  - `tag === "!cel"` → one closed segment spanning the tagged body.
 *  - otherwise → one closed segment per `${{ … }}` match, plus a trailing
 *    `open` segment for a dangling `${{` with no `}}` (bounded to its line, so
 *    an unterminated quote that swallowed following lines still recovers the
 *    region the user is typing in). */
export function buildCelSegments(
  scalarText: string,
  scalarStart: number,
  tag: string | undefined,
  taggedSource: string | undefined,
): CelSegment[] {
  if (tag === "!cel" && taggedSource != null) {
    const idx = scalarText.indexOf(taggedSource);
    const bodyStart = scalarStart + (idx >= 0 ? idx : 0);
    const range: [number, number] = [bodyStart, bodyStart + taggedSource.length];
    return [
      {
        range,
        source: taggedSource,
        open: false,
        ast: () => wrapCelAst(parse(taggedSource).ast, bodyStart),
      },
    ];
  }

  const segments: CelSegment[] = [];
  const re = /\$\{\{([\s\S]*?)\}\}/g;
  let match: RegExpExecArray | null;
  let lastClosedEnd = 0;
  while ((match = re.exec(scalarText)) !== null) {
    const whole = match[0];
    const inner = match[1];
    const leadingWs = inner.match(/^\s*/)?.[0].length ?? 0;
    const bodyStart = scalarStart + match.index + OPEN_MARKER.length + leadingWs;
    const source = inner.trim();
    segments.push({
      range: [scalarStart + match.index, scalarStart + match.index + whole.length],
      source,
      open: false,
      ast: () => wrapCelAst(parse(source).ast, bodyStart),
    });
    lastClosedEnd = match.index + whole.length;
  }

  const openIdx = scalarText.indexOf(OPEN_MARKER, lastClosedEnd);
  if (openIdx >= 0 && scalarText.indexOf("}}", openIdx) < 0) {
    let lineEnd = scalarText.indexOf("\n", openIdx);
    if (lineEnd < 0) lineEnd = scalarText.length;
    const after = openIdx + OPEN_MARKER.length;
    // Drop a trailing scalar-closing quote so `foo: "${{ req"` recovers `req`,
    // not `req"` — the quote closes the YAML string, it isn't part of the CEL.
    const rawBody = scalarText.slice(after, lineEnd).replace(/["']\s*$/, "");
    const leadingWs = rawBody.match(/^\s*/)?.[0].length ?? 0;
    const bodyStart = scalarStart + after + leadingWs;
    const source = rawBody.trim();
    const range: [number, number] = [scalarStart + openIdx, scalarStart + lineEnd];
    segments.push({
      range,
      source,
      open: true,
      ast: () => parseLenient(source, bodyStart, range),
    });
  }

  return segments;
}
