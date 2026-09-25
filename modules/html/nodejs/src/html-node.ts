/** The `Html.Node` / `Html.Parsed` value shapes, as the controllers hold them. */

export type ForeignNamespace = "svg" | "mathml";

export interface ElementNode {
  type: "element";
  tag: string;
  namespace?: ForeignNamespace;
  attrs: Record<string, string>;
  children: HtmlNode[];
}

export interface TextNode {
  type: "text";
  text: string;
}

export interface CommentNode {
  type: "comment";
  text: string;
}

export interface DoctypeNode {
  type: "doctype";
  name: string;
  publicId: string;
  systemId: string;
}

export type HtmlNode = ElementNode | TextNode | CommentNode | DoctypeNode;

export interface Parsed {
  nodes: HtmlNode[];
  baseUrl?: string;
}

export const HTML_NS = "http://www.w3.org/1999/xhtml";
export const SVG_NS = "http://www.w3.org/2000/svg";
export const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

export const NAMESPACE_URIS: Readonly<Record<ForeignNamespace, string>> = {
  svg: SVG_NS,
  mathml: MATHML_NS,
};

export function foreignNamespaceOf(uri: string | null | undefined): ForeignNamespace | undefined {
  if (uri === SVG_NS) return "svg";
  if (uri === MATHML_NS) return "mathml";
  return undefined;
}

/** True for an HTML-namespace element with the given local name. */
export function isHtmlElement(node: ElementNode, tag?: string): boolean;
export function isHtmlElement(node: HtmlNode, tag?: string): node is ElementNode;
export function isHtmlElement(node: HtmlNode, tag?: string): boolean {
  return (
    node.type === "element" && node.namespace === undefined && (tag === undefined || node.tag === tag)
  );
}

/** Every element in tree order. A `<template>`'s contents are inert — not part
 *  of the document a browser queries — so they are not descended into. */
export function* walkElements(nodes: readonly HtmlNode[]): Generator<ElementNode> {
  for (const node of nodes) {
    if (node.type !== "element") continue;
    yield node;
    if (node.namespace !== undefined || node.tag !== "template") yield* walkElements(node.children);
  }
}
