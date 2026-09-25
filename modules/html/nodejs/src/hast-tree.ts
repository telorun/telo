/** `Html.Node` → hast, for the hast-util-* libraries used internally
 *  (to-text, to-mdast). hast never leaves a controller. */

import type { Element as HastElement, ElementContent, Root as HastRoot, RootContent } from "hast";
import { fromParse5 } from "hast-util-from-parse5";
import type { ElementNode, HtmlNode } from "./html-node.js";
import { toParse5Fragment } from "./parse5-tree.js";

export interface HastTree {
  root: HastRoot;
  /** The `Html.Node` each hast element was built from. */
  nodeOf: Map<HastElement, ElementNode>;
  /** The hast element built from each `Html.Node` element. */
  hastOf: Map<ElementNode, HastElement>;
}

export function toHast(nodes: readonly HtmlNode[]): HastTree {
  const { root: fragment } = toParse5Fragment(nodes);
  const root = fromParse5(fragment as never) as HastRoot;
  const nodeOf = new Map<HastElement, ElementNode>();
  const hastOf = new Map<ElementNode, HastElement>();
  pair(nodes, root.children, nodeOf, hastOf);
  return { root, nodeOf, hastOf };
}

/** Elements appear in the same order on both sides; only text merging and
 *  doctypes differ, and neither is an element. */
function pair(
  nodes: readonly HtmlNode[],
  hast: readonly (RootContent | ElementContent)[],
  nodeOf: Map<HastElement, ElementNode>,
  hastOf: Map<ElementNode, HastElement>,
): void {
  const elements = nodes.filter((node): node is ElementNode => node.type === "element");
  const hastElements = hast.filter((node): node is HastElement => node.type === "element");
  if (elements.length !== hastElements.length) {
    throw new Error(
      `html: the internal tree lost elements (${elements.length} became ${hastElements.length})`,
    );
  }
  elements.forEach((element, index) => {
    const counterpart = hastElements[index]!;
    nodeOf.set(counterpart, element);
    hastOf.set(element, counterpart);
    const children =
      counterpart.tagName === "template" && counterpart.content
        ? counterpart.content.children
        : counterpart.children;
    pair(element.children, children, nodeOf, hastOf);
  });
}
