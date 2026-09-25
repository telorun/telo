/** Parent and sibling links for a node tree, which `Html.Node` itself does not
 *  carry. Built once per call; a `<template>`'s contents are not indexed, since
 *  they are not part of the document a selector is matched against. */

import { isHtmlElement, type ElementNode, type HtmlNode } from "./html-node.js";

export interface TreeIndex {
  /** Every indexed element, in document order. */
  readonly elements: readonly ElementNode[];
  /** The top-level elements. */
  readonly topLevel: readonly ElementNode[];
  parentOf(element: ElementNode): ElementNode | undefined;
  /** The element siblings of `element`, itself included, in order. */
  siblingsOf(element: ElementNode): readonly ElementNode[];
  /** Position among `siblingsOf`. */
  indexOf(element: ElementNode): number;
  /** Position in document order. */
  orderOf(element: ElementNode): number;
  /** The element with this `id`, first in document order. */
  byId(id: string): ElementNode | undefined;
}

export function indexTree(nodes: readonly HtmlNode[]): TreeIndex {
  const elements: ElementNode[] = [];
  const parent = new Map<ElementNode, ElementNode | undefined>();
  const siblings = new Map<ElementNode, ElementNode[]>();
  const position = new Map<ElementNode, number>();
  const order = new Map<ElementNode, number>();
  const ids = new Map<string, ElementNode>();

  const visit = (children: readonly HtmlNode[], owner: ElementNode | undefined): ElementNode[] => {
    const row = children.filter((node): node is ElementNode => node.type === "element");
    row.forEach((element, index) => {
      parent.set(element, owner);
      siblings.set(element, row);
      position.set(element, index);
      order.set(element, elements.length);
      elements.push(element);
      const id = element.attrs.id;
      if (id !== undefined && id !== "" && !ids.has(id)) ids.set(id, element);
      if (!isHtmlElement(element, "template")) visit(element.children, element);
    });
    return row;
  };
  const topLevel = visit(nodes, undefined);

  return {
    elements,
    topLevel,
    parentOf: (element) => parent.get(element),
    siblingsOf: (element) => siblings.get(element) ?? [element],
    indexOf: (element) => position.get(element) ?? 0,
    orderOf: (element) => order.get(element) ?? -1,
    byId: (id) => ids.get(id),
  };
}

export function isAncestor(index: TreeIndex, ancestor: ElementNode, element: ElementNode): boolean {
  for (let at = index.parentOf(element); at; at = index.parentOf(at)) if (at === ancestor) return true;
  return false;
}

/** The element descendants of `element`, in document order. */
export function descendantsOf(index: TreeIndex, element: ElementNode): ElementNode[] {
  const out: ElementNode[] = [];
  const start = index.orderOf(element);
  for (let i = start + 1; i < index.elements.length; i++) {
    const candidate = index.elements[i]!;
    if (!isAncestor(index, element, candidate)) break;
    out.push(candidate);
  }
  return out;
}

/** All text beneath `nodes`, template contents excluded. */
export function textOf(nodes: readonly HtmlNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") out += node.text;
    else if (node.type === "element" && !isHtmlElement(node, "template")) out += textOf(node.children);
  }
  return out;
}
