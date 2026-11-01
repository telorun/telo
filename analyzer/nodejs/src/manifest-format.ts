import { defaultCustomTags } from "@telorun/templating";
import {
  Scalar,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseAllDocuments,
  Document,
  type Node,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";

const MAX_FLOW_MAP_ENTRIES = 3;

export interface ManifestFormatFailure {
  message: string;
  line: number;
  column: number;
}

export type ManifestFormatResult =
  | { ok: true; text: string; changed: boolean }
  | { ok: false; error: ManifestFormatFailure };

function isPlainValue(node: unknown): node is Scalar {
  if (!isScalar(node)) return false;
  if (node.tag || node.comment || node.commentBefore) return false;
  if (typeof node.value === "string" && node.value.includes("\n")) return false;
  return node.type !== "BLOCK_LITERAL" && node.type !== "BLOCK_FOLDED";
}

function isQuiet(node: Node): boolean {
  return !node.tag && !node.comment && !node.commentBefore;
}

function flowable(node: unknown): boolean {
  if (isSeq(node)) return seqFlowable(node);
  if (isMap(node)) return mapFlowable(node);
  return isPlainValue(node);
}

function seqFlowable(seq: YAMLSeq): boolean {
  return isQuiet(seq) && seq.items.every(isPlainValue);
}

function mapFlowable(map: YAMLMap): boolean {
  if (!isQuiet(map) || map.items.length > MAX_FLOW_MAP_ENTRIES) return false;
  return map.items.every(
    (pair) =>
      isScalar(pair.key) &&
      isPlainValue(pair.key) &&
      !isAlias(pair.value) &&
      pair.value != null &&
      flowable(pair.value),
  );
}

const MAX_FLOW_MAP_WIDTH = 80;

interface Edit {
  start: number;
  end: number;
  text: string;
}

function renderDocument(node: Node, padding: boolean): string {
  const doc = new Document();
  doc.contents = node;
  return doc.toString({ lineWidth: 0, flowCollectionPadding: padding }).trimEnd();
}

/** One-line text of a flowable collection: sequences unpadded (`[a, b]`), maps padded (`{ a: 1 }`). */
function renderFlow(node: YAMLSeq | YAMLMap, token: string): string {
  const copy = node.clone() as YAMLSeq | YAMLMap;
  if (isSeq(copy)) {
    copy.flow = true;
    return renderDocument(copy, false);
  }
  const inner = new Map<string, string>();
  copy.flow = true;
  for (const pair of copy.items) {
    const value = pair.value;
    if (isSeq(value) || isMap(value)) {
      const key = `${token}${inner.size}__`;
      inner.set(key, renderFlow(value as YAMLSeq | YAMLMap, token));
      pair.value = new Scalar(key);
    }
  }
  let text = renderDocument(copy, true);
  for (const [key, value] of inner) text = text.replace(key, () => value);
  return text;
}

function flowText(node: unknown, token: string): string | null {
  if (isSeq(node)) {
    return node.flow || !seqFlowable(node) ? null : renderFlow(node, token);
  }
  if (isMap(node)) {
    if (node.flow || !mapFlowable(node)) return null;
    const text = renderFlow(node, token);
    return text.length <= MAX_FLOW_MAP_WIDTH ? text : null;
  }
  return null;
}

function sourceEnd(text: string, range: [number, number, number]): number {
  return range[0] + text.slice(range[0], range[1]).trimEnd().length;
}

function collectEdits(node: unknown, text: string, token: string, edits: Edit[]): void {
  if (isSeq(node)) {
    for (const item of node.items) {
      const flow = flowText(item, token);
      const range = (item as Node).range;
      if (flow !== null && range) {
        edits.push({ start: range[0], end: sourceEnd(text, range), text: flow });
      } else collectEdits(item, text, token, edits);
    }
  } else if (isMap(node)) {
    for (const pair of node.items) {
      const keyRange = (pair.key as Node | null)?.range;
      const value = pair.value as Node | null;
      const flow = flowText(value, token);
      if (flow !== null && keyRange && value?.range) {
        const between = text.slice(keyRange[1], value.range[0]);
        if (/^\s*:\s*$/.test(between)) {
          edits.push({ start: keyRange[1], end: sourceEnd(text, value.range), text: `: ${flow}` });
          continue;
        }
      }
      collectEdits(value, text, token, edits);
    }
  }
}

/** A manifest's first document names a dotted `kind` (`Telo.Application`, `Http.Server`) — read
 *  even from text that does not fully parse, so a broken manifest is reported, not skipped. */
export function isManifestText(text: string): boolean {
  const [first] = parseAllDocuments(text, { customTags: defaultCustomTags() });
  if (!first) return false;
  const kind = first.get("kind");
  return typeof kind === "string" && /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(kind);
}

/**
 * Rewrites the layout of a manifest — collection style only; the parsed data,
 * tags included, is unchanged. Idempotent.
 */
export function formatManifestText(text: string): ManifestFormatResult {
  const documents = parseAllDocuments(text, { customTags: defaultCustomTags() });
  for (const doc of documents) {
    const error = doc.errors[0];
    if (error) {
      const pos = error.linePos?.[0];
      return {
        ok: false,
        error: {
          message: error.message.split("\n")[0]!.replace(/ at line \d+, column \d+:?$/, ""),
          line: pos?.line ?? 1, column: pos?.col ?? 1 },
      };
    }
  }

  let token = "TELOFLOW";
  while (text.includes(token)) token += "X";

  const edits: Edit[] = [];
  for (const doc of documents) collectEdits(doc.contents, text, `__${token}_`, edits);

  let formatted = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    formatted = formatted.slice(0, edit.start) + edit.text + formatted.slice(edit.end);
  }
  return { ok: true, text: formatted, changed: formatted !== text };
}
