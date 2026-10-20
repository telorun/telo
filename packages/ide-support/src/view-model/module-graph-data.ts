import type { ModuleGraph } from "@telorun/analyzer";
import type { ModuleGraphData } from "@telorun/editor-protocol";

/** A module graph's data fields, its query methods left behind. */
export function moduleGraphData(graph: ModuleGraph): ModuleGraphData {
  return {
    ...(graph.root ? { root: graph.root } : {}),
    nodes: graph.nodes,
    edges: graph.edges,
    regions: graph.regions,
    kinds: graph.kinds,
  };
}
