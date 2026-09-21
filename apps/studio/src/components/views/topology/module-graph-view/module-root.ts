import type { GraphEdge, ModuleGraph } from "@telorun/analyzer";

/**
 * The module root is never a box.
 *
 * It is not a resource: what it carries is the module's own declarations, and
 * the side panel lists those — the boot sequence included, which also marks each
 * resource it starts. Drawn, it was one more box every edge out of `targets:`
 * converged on, standing left of everything the module actually runs.
 *
 * The projection keeps the root; the view decides not to draw it, so the edges
 * leaving it go with it.
 */
export function leavesModuleRoot(graph: ModuleGraph, edge: GraphEdge): boolean {
  return !!graph.root && edge.from === graph.root.id;
}

/** `ids` without the module root. */
export function withoutModuleRoot(graph: ModuleGraph, ids: ReadonlySet<string>): Set<string> {
  return new Set([...ids].filter((id) => id !== graph.root?.id));
}
