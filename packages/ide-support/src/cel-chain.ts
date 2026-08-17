import type { CelNode } from "@telorun/analyzer";

/** One identifier of a dotted CEL chain, with the span a cursor hit-tests
 *  against and a rename replaces. */
export interface ChainPart {
  name: string;
  range: [number, number];
}

/**
 * Flatten `a.b.c` into its identifiers. Returns undefined as soon as the chain
 * is rooted in something other than a plain identifier (a call, an index), so a
 * navigable — or renameable — prefix is never invented out of a computed
 * expression.
 */
export function flattenChain(node: CelNode): ChainPart[] | undefined {
  if (node.kind === "ident") return [{ name: node.name, range: node.range }];
  if (node.kind !== "member") return undefined;
  const head = flattenChain(node.target);
  return head ? [...head, { name: node.property, range: node.propertyRange }] : undefined;
}

/**
 * A node's children.
 *
 * Exhaustive by construction: a new `CelNode` variant fails the build here
 * rather than silently going unwalked, so the analyzer's node model and the
 * walks over it cannot drift apart unnoticed. That matters twice over — for
 * go-to-definition an unwalked variant is a missed jump, for a rename it is a
 * reference left pointing at the old name.
 */
export function celChildren(node: CelNode): CelNode[] {
  switch (node.kind) {
    case "literal":
    case "ident":
      return [];
    case "member":
      return [node.target];
    case "index":
      return [node.target, node.index];
    case "call":
      return node.args;
    case "methodCall":
      return [node.receiver, ...node.args];
    case "list":
      return node.items;
    case "map":
      return node.entries.flatMap((e) => [e.key, e.value]);
    case "ternary":
      return [node.cond, node.then, node.else];
    case "unary":
      return [node.operand];
    case "binary":
      return [node.left, node.right];
  }
  const unhandled: never = node;
  throw new Error(`Unhandled CEL node: ${JSON.stringify(unhandled)}`);
}

/** Every node of the tree, outermost first. */
export function walkCel(node: CelNode, visit: (node: CelNode) => void): void {
  visit(node);
  for (const child of celChildren(node)) walkCel(child, visit);
}

/**
 * The dotted chain under `offset`, and which of its identifiers was hit. The
 * walk is outermost-first so the longest chain wins — `resources.store.conn`
 * resolves as one chain rather than as its `resources.store` prefix.
 */
export function chainAt(
  node: CelNode,
  offset: number,
): { parts: ChainPart[]; index: number } | undefined {
  if (offset < node.range[0] || offset > node.range[1]) return undefined;
  const parts = flattenChain(node);
  if (parts) {
    const index = parts.findIndex((p) => offset >= p.range[0] && offset <= p.range[1]);
    if (index >= 0) return { parts, index };
  }
  for (const child of celChildren(node)) {
    const hit = chainAt(child, offset);
    if (hit) return hit;
  }
  return undefined;
}
