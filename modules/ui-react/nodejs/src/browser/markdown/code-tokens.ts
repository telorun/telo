import type { ElementContent, Root } from "hast";
import { common, createLowlight } from "lowlight";

/** What a run of code is, in the closed vocabulary `data-token` carries. */
export const TOKEN_KINDS = [
  "comment",
  "string",
  "number",
  "keyword",
  "constant",
  "function",
  "type",
  "operator",
  "punctuation",
  "property",
  "variable",
  "inserted",
  "deleted",
] as const;

export type TokenKind = (typeof TOKEN_KINDS)[number];

/** A run of code: plain when `kind` is absent. */
export interface CodeToken {
  text: string;
  kind?: TokenKind;
}

/** The longest code that is highlighted; a longer block is drawn plain. */
export const HIGHLIGHT_LIMIT = 50_000;

const lowlight = createLowlight(common);

/** The kind a highlighter scope (`hljs-<scope>`, with its sub-scopes) stands for. */
function kindOf(scopes: readonly string[]): TokenKind | undefined {
  const [scope, ...rest] = scopes.map((name) => name.replace(/^hljs-/, ""));
  switch (scope) {
    case "comment":
    case "doctag":
    case "quote":
      return "comment";
    case "string":
    case "regexp":
      return "string";
    case "number":
      return "number";
    case "keyword":
    case "meta":
    case "selector-tag":
      return "keyword";
    case "literal":
    case "built_in":
    case "symbol":
      return "constant";
    case "title":
      return rest.includes("class_") ? "type" : "function";
    case "type":
    case "class":
      return "type";
    case "operator":
      return "operator";
    case "punctuation":
      return "punctuation";
    case "attr":
    case "attribute":
    case "property":
    case "tag":
    case "name":
    case "selector-id":
    case "selector-class":
      return "property";
    case "variable":
    case "params":
    case "template-variable":
      return "variable";
    case "addition":
      return "inserted";
    case "deletion":
      return "deleted";
    default:
      return undefined;
  }
}

function collect(nodes: readonly ElementContent[], inherited: TokenKind | undefined, into: CodeToken[]): void {
  for (const node of nodes) {
    if (node.type === "text") {
      const last = into[into.length - 1];
      if (last && last.kind === inherited) last.text += node.value;
      else into.push(inherited === undefined ? { text: node.value } : { text: node.value, kind: inherited });
    } else if (node.type === "element") {
      const classes = node.properties.className;
      collect(node.children, inherited ?? (Array.isArray(classes) ? kindOf(classes.map(String)) : undefined), into);
    }
  }
}

/**
 * Code as runs of tokens. A language the highlighter does not know, a block over
 * {@link HIGHLIGHT_LIMIT} and a block with no language are one plain run.
 */
export function tokenize(code: string, language: string | undefined): CodeToken[] {
  const name = language?.trim().split(/\s+/)[0]?.toLowerCase();
  if (!name || code.length > HIGHLIGHT_LIMIT || !lowlight.registered(name)) return [{ text: code }];
  const tree: Root = lowlight.highlight(name, code);
  const tokens: CodeToken[] = [];
  collect(tree.children as ElementContent[], undefined, tokens);
  return tokens;
}
