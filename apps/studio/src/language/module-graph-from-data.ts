import type { GraphEdge, GraphKind, GraphNode, GraphRegion, ModuleGraph } from "@telorun/analyzer";
import type { ModuleGraphData } from "@telorun/editor-protocol";

const graphs = new WeakMap<ModuleGraphData, ModuleGraph>();

/**
 * The analyzer's module graph over the plain data an engine serves: the same
 * nodes, edges, regions and kinds, with the lookups indexed once per data
 * object, so every view drawing a module reads it as it reads one the analyzer
 * built. The data is the analyzer's projection carried as JSON, so its widened
 * enumerations hold the analyzer's values.
 */
export function moduleGraphFromData(data: ModuleGraphData): ModuleGraph {
  const known = graphs.get(data);
  if (known) return known;
  const root = data.root as GraphNode | undefined;
  const nodes = data.nodes as GraphNode[];
  const edges = data.edges as GraphEdge[];
  const byId = new Map<string, GraphNode>();
  if (root) byId.set(root.id, root);
  for (const node of nodes) byId.set(node.id, node);
  const from = new Map<string, GraphEdge[]>();
  const to = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    from.set(edge.from, [...(from.get(edge.from) ?? []), edge]);
    if (edge.to) to.set(edge.to, [...(to.get(edge.to) ?? []), edge]);
  }
  const graph: ModuleGraph = {
    ...(root ? { root } : {}),
    nodes,
    edges,
    regions: data.regions as GraphRegion[],
    kinds: data.kinds as GraphKind[],
    nodeById: (id) => byId.get(id),
    edgesFrom: (id) => from.get(id) ?? [],
    edgesTo: (id) => to.get(id) ?? [],
  };
  graphs.set(data, graph);
  return graph;
}
