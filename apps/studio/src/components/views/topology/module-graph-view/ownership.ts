import type { GraphNode, ModuleGraph } from "@telorun/analyzer";

/**
 * Children each box draws inside itself, in declaration order.
 *
 * An OWNED declaration — one written inline at a slot, or inside a `with:`
 * scope — belongs inside its owner's box because the manifest says so: it
 * exists nowhere but that owner's YAML. Nothing else nests: a box drawn inside
 * another is a claim the manifest has to make.
 */
export function ownershipIndex(graph: ModuleGraph): Map<string, GraphNode[]> {
  const owned = new Map<string, GraphNode[]>();
  for (const node of graph.nodes) {
    if (node.ownership !== "inline" && node.ownership !== "scoped") continue;
    if (!node.owner) continue;
    owned.set(node.owner, [...(owned.get(node.owner) ?? []), node]);
  }
  return owned;
}
