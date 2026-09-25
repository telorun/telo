/** The one parser (parse5, WHATWG tree construction) and the translation between
 *  its tree and `Html.Node`, in both directions. The reverse direction exists for
 *  the hast adapter, which reads a parse5-shaped tree. */

import {
  defaultTreeAdapter,
  html as parse5Html,
  parse,
  parseFragment,
  type DefaultTreeAdapterMap,
} from "parse5";
import {
  foreignNamespaceOf,
  HTML_NS,
  NAMESPACE_URIS,
  type ElementNode,
  type HtmlNode,
} from "./html-node.js";

type P5Node = DefaultTreeAdapterMap["node"];
type P5Parent = DefaultTreeAdapterMap["parentNode"];
type P5Element = DefaultTreeAdapterMap["element"];
type P5Template = DefaultTreeAdapterMap["template"];

/** Parses a whole document, or a fragment (no implied `html`/`head`/`body`). */
export function parseHtml(text: string, fragment: boolean): HtmlNode[] {
  const root: P5Parent = fragment ? parseFragment(text) : parse(text);
  return childrenOf(root);
}

function childrenOf(parent: P5Parent): HtmlNode[] {
  const out: HtmlNode[] = [];
  for (const child of parent.childNodes) {
    const node = fromParse5(child);
    if (node) out.push(node);
  }
  return out;
}

function fromParse5(node: P5Node): HtmlNode | undefined {
  switch (node.nodeName) {
    case "#text":
      return { type: "text", text: (node as DefaultTreeAdapterMap["textNode"]).value };
    case "#comment":
      return { type: "comment", text: (node as DefaultTreeAdapterMap["commentNode"]).data };
    case "#documentType": {
      const doctype = node as DefaultTreeAdapterMap["documentType"];
      return {
        type: "doctype",
        name: doctype.name ?? "",
        publicId: doctype.publicId ?? "",
        systemId: doctype.systemId ?? "",
      };
    }
    default: {
      if (!("tagName" in node)) return undefined;
      const element = node as P5Element;
      const attrs: Record<string, string> = {};
      for (const attr of element.attrs) {
        const name = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
        if (!(name in attrs)) attrs[name] = attr.value;
      }
      const namespace = foreignNamespaceOf(element.namespaceURI);
      const content =
        element.tagName === "template" && element.namespaceURI === HTML_NS
          ? (element as P5Template).content
          : element;
      const out: ElementNode = {
        type: "element",
        tag: element.tagName,
        attrs,
        children: childrenOf(content),
      };
      if (namespace) out.namespace = namespace;
      return out;
    }
  }
}

const XLINK_NS = "http://www.w3.org/1999/xlink";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";

/** A qualified attribute name split the way the parser splits a foreign one. */
function toParse5Attr(name: string, value: string) {
  const colon = name.indexOf(":");
  const prefix = colon > 0 ? name.slice(0, colon) : "";
  const namespace =
    prefix === "xlink" ? XLINK_NS : prefix === "xml" ? XML_NS : prefix === "xmlns" || name === "xmlns" ? XMLNS_NS : undefined;
  return namespace && prefix
    ? { name: name.slice(colon + 1), value, prefix, namespace }
    : { name, value };
}

/** `Html.Node`s as a parse5 fragment, with each created element mapped back to
 *  the node it came from. */
export function toParse5Fragment(nodes: readonly HtmlNode[]): {
  root: DefaultTreeAdapterMap["documentFragment"];
  origin: Map<P5Element, ElementNode>;
} {
  const origin = new Map<P5Element, ElementNode>();
  const root = defaultTreeAdapter.createDocumentFragment();
  appendAll(root, nodes, origin);
  return { root, origin };
}

function appendAll(parent: P5Parent, nodes: readonly HtmlNode[], origin: Map<P5Element, ElementNode>) {
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        defaultTreeAdapter.insertText(parent, node.text);
        break;
      case "comment":
        defaultTreeAdapter.appendChild(parent, defaultTreeAdapter.createCommentNode(node.text));
        break;
      case "doctype":
        // A doctype is a child of a document only; in a fragment it carries no
        // content any consumer of this tree reads.
        break;
      case "element": {
        const namespaceUri = node.namespace ? NAMESPACE_URIS[node.namespace] : HTML_NS;
        const element = defaultTreeAdapter.createElement(
          node.tag,
          namespaceUri as parse5Html.NS,
          Object.entries(node.attrs).map(([name, value]) => toParse5Attr(name, value)),
        );
        origin.set(element, node);
        defaultTreeAdapter.appendChild(parent, element);
        if (node.tag === "template" && !node.namespace) {
          const content = defaultTreeAdapter.createDocumentFragment();
          defaultTreeAdapter.setTemplateContent(element as P5Template, content);
          appendAll(content, node.children, origin);
        } else {
          appendAll(element, node.children, origin);
        }
        break;
      }
    }
  }
}
