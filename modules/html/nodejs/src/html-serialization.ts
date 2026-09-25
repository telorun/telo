/**
 * The HTML fragment serialization algorithm over `Html.Node`, extended to write
 * a doctype's public and system identifiers so a legacy doctype survives a
 * round trip — and the one predicate saying whether a tree can be written
 * faithfully, which Markup, Extraction and SafeTree all ask.
 *
 * The predicate is a readback: the tree is serialized, the output parsed again
 * by the WHATWG tree builder, and the result compared with the tree. A tree
 * that does not read back as itself is refused rather than written as markup
 * that reads back as a different tree.
 */

import type { ElementNode, HtmlNode } from "./html-node.js";
import { parseHtml } from "./parse5-tree.js";

export const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  "area", "base", "basefont", "bgsound", "br", "col", "embed", "frame", "hr", "img",
  "input", "keygen", "link", "meta", "param", "source", "track", "wbr",
]);

/** Elements whose content is raw text. `noscript` included: the parser runs
 *  with scripting enabled, so its contents are raw text too. */
export const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set([
  "style", "script", "xmp", "iframe", "noembed", "noframes", "plaintext", "noscript",
]);

/** Elements whose content is text with character references. */
export const ESCAPABLE_RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(["textarea", "title"]);

/** A leading newline right after these start tags is dropped by the parser. */
const NEWLINE_EATING = new Set(["pre", "textarea", "listing"]);

function escapeText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/ /g, "&nbsp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/ /g, "&nbsp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** A doctype identifier, quoted with `'` when it holds `"`. */
function quoteIdentifier(value: string): string {
  return value.includes('"') ? `'${value}'` : `"${value}"`;
}

function isRawTextParent(parent: ElementNode | undefined): parent is ElementNode {
  return parent !== undefined && !parent.namespace && RAW_TEXT_ELEMENTS.has(parent.tag);
}

export function serializeNodes(nodes: readonly HtmlNode[]): string {
  let out = "";
  for (const node of nodes) out += serializeNode(node, undefined);
  return out;
}

/** The outer serialization of one node. */
export function serializeNode(node: HtmlNode, parent: ElementNode | undefined): string {
  switch (node.type) {
    case "text":
      return isRawTextParent(parent) ? node.text : escapeText(node.text);
    case "comment":
      return `<!--${node.text}-->`;
    case "doctype":
      return serializeDoctype(node.name, node.publicId, node.systemId);
    case "element": {
      let out = `<${node.tag}`;
      for (const [name, value] of Object.entries(node.attrs)) {
        out += ` ${name}="${escapeAttribute(value)}"`;
      }
      out += ">";
      const html = !node.namespace;
      if (html && VOID_ELEMENTS.has(node.tag)) return out;
      const first = node.children[0];
      if (html && NEWLINE_EATING.has(node.tag) && first?.type === "text" && first.text.startsWith("\n")) {
        out += "\n";
      }
      for (const child of node.children) out += serializeNode(child, node);
      return `${out}</${node.tag}>`;
    }
  }
}

function serializeDoctype(name: string, publicId: string, systemId: string): string {
  if (publicId) {
    const system = systemId ? ` ${quoteIdentifier(systemId)}` : "";
    return `<!DOCTYPE ${name} PUBLIC ${quoteIdentifier(publicId)}${system}>`;
  }
  if (systemId) return `<!DOCTYPE ${name} SYSTEM ${quoteIdentifier(systemId)}>`;
  return `<!DOCTYPE ${name}>`;
}

/** Where a tree does not read back as itself, and what it reads back as. */
export interface SerializationProblem {
  /** The first differing node's path (`nodes[0].children[2]`). */
  readonly path: string;
  readonly reason: string;
}

/** A tree whose top level holds an `html` element reads back as a document;
 *  any other as a fragment, in the `template` context `Html.JsonTree` uses. */
function readsAsDocument(nodes: readonly HtmlNode[]): boolean {
  return nodes.some((node) => node.type === "element" && !node.namespace && node.tag === "html");
}

/** What the serialized `nodes` read back as through the WHATWG tree builder. */
export function readBack(nodes: readonly HtmlNode[]): HtmlNode[] {
  return parseHtml(serializeNodes(nodes), !readsAsDocument(nodes));
}

/** The readback of `nodes` and the first node where it differs from them. */
export function checkReadback(
  nodes: readonly HtmlNode[],
  path = "nodes",
): { readonly readback: HtmlNode[]; readonly problem?: SerializationProblem } {
  const readback = readBack(nodes);
  const problem = compareLists(nodes, readback, (i) => `${path}[${i}]`, path);
  return problem ? { readback, problem } : { readback };
}

/** The first node under `nodes` that does not read back as itself; `path`
 *  names the list holding them. */
export function findUnserializable(nodes: readonly HtmlNode[], path: string): SerializationProblem | undefined {
  return checkReadback(nodes, path).problem;
}

/** The same check for one node written on its own, `path` being its own path. */
export function findUnserializableIn(node: HtmlNode, path: string): SerializationProblem | undefined {
  return compareLists([node], readBack([node]), () => path, path);
}

interface Entry {
  readonly node: HtmlNode;
  /** The index of the node, or of the first text node merged into it. */
  readonly index: number;
}

/** DOM normalization: adjacent text nodes merged, empty ones dropped. */
function normalized(nodes: readonly HtmlNode[]): Entry[] {
  const out: Entry[] = [];
  nodes.forEach((node, index) => {
    if (node.type === "text") {
      if (node.text === "") return;
      const last = out[out.length - 1];
      if (last?.node.type === "text") {
        out[out.length - 1] = { node: { type: "text", text: last.node.text + node.text }, index: last.index };
        return;
      }
    }
    out.push({ node, index });
  });
  return out;
}

function compareLists(
  written: readonly HtmlNode[],
  read: readonly HtmlNode[],
  pathAt: (index: number) => string,
  owner: string,
): SerializationProblem | undefined {
  const mine = normalized(written);
  const theirs = normalized(read);
  for (let k = 0; k < Math.max(mine.length, theirs.length); k++) {
    const own = mine[k];
    const other = theirs[k]?.node;
    if (!own) {
      const last = mine[mine.length - 1];
      return last
        ? { path: pathAt(last.index), reason: `it reads back followed by ${describe(other!)}` }
        : { path: owner, reason: `it reads back holding ${describe(other!)}` };
    }
    const path = pathAt(own.index);
    if (!other) return { path, reason: `nothing reads back in place of ${describe(own.node)}` };
    if (!sameNode(own.node, other)) {
      return { path, reason: `it reads back as ${describe(other)}, not ${describe(own.node)}` };
    }
    if (own.node.type === "element") {
      const problem = compareLists(
        own.node.children,
        (other as ElementNode).children,
        (i) => `${path}.children[${i}]`,
        path,
      );
      if (problem) return problem;
    }
  }
  return undefined;
}

function sameNode(a: HtmlNode, b: HtmlNode): boolean {
  switch (a.type) {
    case "text":
    case "comment":
      return b.type === a.type && b.text === a.text;
    case "doctype":
      return b.type === "doctype" && b.name === a.name && b.publicId === a.publicId && b.systemId === a.systemId;
    case "element": {
      if (b.type !== "element" || b.tag !== a.tag || b.namespace !== a.namespace) return false;
      const names = Object.keys(a.attrs);
      return (
        names.length === Object.keys(b.attrs).length &&
        names.every((name) => Object.hasOwn(b.attrs, name) && b.attrs[name] === a.attrs[name])
      );
    }
  }
}

const NAMESPACE_LABELS = { svg: "SVG", mathml: "MathML" } as const;

function quoted(text: string): string {
  return JSON.stringify(text.length > 60 ? `${text.slice(0, 60)}…` : text);
}

function describe(node: HtmlNode): string {
  switch (node.type) {
    case "text":
      return `the text ${quoted(node.text)}`;
    case "comment":
      return `the comment ${quoted(node.text)}`;
    case "doctype":
      return `a doctype ${quoted(node.name)}`;
    case "element": {
      const attrs = Object.entries(node.attrs)
        .map(([name, value]) => ` ${name}=${quoted(value)}`)
        .join("");
      return `the ${node.namespace ? NAMESPACE_LABELS[node.namespace] : "HTML"} element <${node.tag}${attrs}>`;
    }
  }
}
