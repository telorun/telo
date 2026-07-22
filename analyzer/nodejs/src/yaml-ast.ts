import { defaultCustomTags, isTaggedSentinel } from "@telorun/templating";
import { isMap, isScalar, isSeq, parseAllDocuments, type Document, type Node } from "yaml";
import { buildCelSegments, type CelSegment } from "./cel-ast.js";

/** Read-only YAML node model owned by the analyzer — the shared, browser-safe
 *  structural source of truth for every IDE feature. Ranges are `[start, end]`
 *  in byte offsets (yaml's value-end, so a range spans exactly the node's own
 *  text, not the trailing newline). `yaml` is an internal implementation
 *  detail behind `parseToAst`; no consumer imports it to read structure. */
export type AstNode = AstMap | AstSeq | AstScalar;

export interface AstMap {
  kind: "map";
  range: [number, number];
  entries: AstPair[];
}

export interface AstSeq {
  kind: "seq";
  range: [number, number];
  items: AstNode[];
}

export interface AstScalar {
  kind: "scalar";
  range: [number, number];
  /** Resolved scalar value — a `TaggedSentinel` for `!cel` / `!ref` scalars. */
  value: unknown;
  /** The scalar's tag when present (`!cel`, `!ref`, …). */
  tag?: string;
  /** The embedded CEL regions (lazy — nothing parses CEL until called). */
  celSegments(): CelSegment[];
}

export interface AstPair {
  key: AstNode;
  value?: AstNode;
}

export interface AstDocument {
  root?: AstNode;
  /** Full document span `[start, end]` — used to select the `---` document a
   *  cursor offset falls in. */
  range: [number, number];
}

/** Parse `text` into the read-only AST. Wraps `parseAllDocuments` with the
 *  repo's custom tags (`!cel` / `!ref`) and adapts each `yaml` tree into a
 *  thin `AstNode` view — CEL parsing stays deferred to `celSegments().ast()`. */
export function parseToAst(text: string): AstDocument[] {
  const documents = parseAllDocuments(text, { customTags: defaultCustomTags() });
  return documents.map((doc) => documentToAst(doc, text));
}

/** Adapt one already-parsed `yaml.Document` into an `AstDocument`. Lets a host
 *  that already parsed for analysis reuse that parse instead of re-parsing. */
export function documentToAst(doc: Document, text: string): AstDocument {
  const r = doc.range as [number, number, number] | null | undefined;
  return {
    root: doc.contents ? adaptNode(doc.contents, text) : undefined,
    range: r ? [r[0], r[2]] : [0, text.length],
  };
}

function nodeRange(node: Node): [number, number] {
  const r = node.range as [number, number, number] | null | undefined;
  return r ? [r[0], r[1]] : [0, 0];
}

function adaptNode(node: Node, text: string): AstNode | undefined {
  if (isMap(node)) {
    const entries: AstPair[] = [];
    for (const item of node.items) {
      const key = adaptNode(item.key as Node, text);
      if (!key) continue;
      const value = item.value != null ? adaptNode(item.value as Node, text) : undefined;
      entries.push({ key, value });
    }
    return { kind: "map", range: nodeRange(node), entries };
  }
  if (isSeq(node)) {
    const items: AstNode[] = [];
    for (const item of node.items) {
      const adapted = adaptNode(item as Node, text);
      if (adapted) items.push(adapted);
    }
    return { kind: "seq", range: nodeRange(node), items };
  }
  if (isScalar(node)) {
    const range = nodeRange(node);
    const value = node.value;
    const tag = typeof node.tag === "string" ? node.tag : undefined;
    return {
      kind: "scalar",
      range,
      value,
      tag,
      celSegments: () =>
        buildCelSegments(
          text.slice(range[0], range[1]),
          range[0],
          tag,
          isTaggedSentinel(value) ? value.source : undefined,
        ),
    };
  }
  return undefined;
}
