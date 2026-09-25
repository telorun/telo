/** `Html.Node` ↔ a DOM, for the one consumer that needs a live document (main
 *  content detection). The DOM is built fresh from the node tree on every call;
 *  no HTML text is ever parsed on this path. */

import { parseHTML } from "linkedom";
import {
  foreignNamespaceOf,
  HTML_NS,
  isHtmlElement,
  NAMESPACE_URIS,
  type ElementNode,
  type HtmlNode,
} from "./html-node.js";

type DomDocument = ReturnType<typeof parseHTML>["document"];
type DomNode = DomDocument["documentElement"]["childNodes"][number];

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;

/** A document holding `nodes`: the `<html>` element among them becomes the
 *  document element; otherwise a `<head>` among them is the head and the rest
 *  is placed in `<body>`. */
export function toDomDocument(nodes: readonly HtmlNode[]): DomDocument {
  const { document } = parseHTML("");
  const html = nodes.find((node): node is ElementNode => isHtmlElement(node, "html"));
  if (html) {
    document.appendChild(toDom(document, html));
  } else {
    // A selection holding the page's `<head>` keeps it as the head, so what the
    // detector reads there (title, language, JSON-LD) is still found.
    const head = nodes.find((node): node is ElementNode => isHtmlElement(node, "head"));
    const root = document.createElement("html");
    root.appendChild(head ? toDom(document, head) : document.createElement("head"));
    const body = document.createElement("body");
    for (const node of nodes) {
      if (node !== head && node.type !== "doctype") body.appendChild(toDom(document, node));
    }
    root.appendChild(body);
    document.appendChild(root);
  }
  return document;
}

function toDom(document: DomDocument, node: Exclude<HtmlNode, { type: "doctype" }>): any {
  switch (node.type) {
    case "text":
      return document.createTextNode(node.text);
    case "comment":
      return document.createComment(node.text);
    case "element": {
      const element = node.namespace
        ? document.createElementNS(NAMESPACE_URIS[node.namespace], node.tag)
        : document.createElement(node.tag);
      for (const [name, value] of Object.entries(node.attrs)) element.setAttribute(name, value);
      const container = isHtmlElement(node, "template") ? (element as any).content : element;
      for (const child of node.children) {
        if (child.type !== "doctype") container.appendChild(toDom(document, child));
      }
      return element;
    }
  }
}

export function fromDomChildren(parent: { childNodes: ArrayLike<DomNode> }): HtmlNode[] {
  const out: HtmlNode[] = [];
  for (const child of Array.from(parent.childNodes)) {
    const node = fromDom(child);
    if (node) out.push(node);
  }
  return out;
}

function fromDom(dom: any): HtmlNode | undefined {
  switch (dom.nodeType) {
    case TEXT_NODE:
      return { type: "text", text: dom.data };
    case COMMENT_NODE:
      return { type: "comment", text: dom.data };
    case ELEMENT_NODE: {
      const namespace = dom.namespaceURI === HTML_NS ? undefined : foreignNamespaceOf(dom.namespaceURI);
      const tag = namespace ? dom.localName : String(dom.localName).toLowerCase();
      const attrs: Record<string, string> = {};
      for (const attr of Array.from(dom.attributes as ArrayLike<{ name: string; value: string }>)) {
        if (!(attr.name in attrs)) attrs[attr.name] = attr.value;
      }
      const container = !namespace && tag === "template" ? dom.content : dom;
      const element: ElementNode = { type: "element", tag, attrs, children: fromDomChildren(container) };
      if (namespace) element.namespace = namespace;
      return element;
    }
    default:
      return undefined;
  }
}
