import type { GraphEdge, GraphNode, ModuleGraph } from "@telorun/analyzer";

/**
 * Where a node is drawn — the view's decision, taken from facts the projection
 * states rather than from any kind name.
 *
 * **There is no ingress LANE**, and there was: entry points had a column of
 * their own, which pulled a whole chain into it (a server is a boot target, the
 * router it mounts declares the trigger) and stacked what the manifest reads as
 * a left-to-right sequence into a vertical rail with edges routing back behind
 * the boxes. Being a way in is a property of a NODE, not a place on the canvas —
 * {@link isEntryPoint} marks it, and the flow ranking puts it at the left by
 * construction, since nothing flows into it.
 *
 * **There is no infrastructure BAND either.** It existed to pin providers and
 * named shapes into a final column, and those are no longer on the canvas at
 * all — they are drawers now (see `off-canvas.ts`). What ambient declaration
 * remains is one control genuinely transfers to, and pinning THAT last would
 * contradict the one thing a column means: how far along the flow it sits.
 */

/** A use that means control arrives from OUTSIDE the application: a request, a
 *  timer, a message. Read off the edge rather than the kind, so a third-party
 *  trigger lands in the rail with no editor change. */
function isInboundTrigger(edge: GraphEdge): boolean {
  return edge.use.includes("trigger.inbound");
}

/**
 * Is this a way work ENTERS the application?
 *
 * The module root is one — boot is where a run begins — and so is any resource
 * that registers an inbound trigger: a route table, a schedule, a tool list.
 * Read off the edge's `use`, so a third-party trigger kind is marked with no
 * editor change.
 */
export function isEntryPoint(node: GraphNode, graph: ModuleGraph): boolean {
  return !!node.root || graph.edgesFrom(node.id).some(isInboundTrigger);
}

/**
 * How far along the flow a node sits — its column, which the layout PINS rather
 * than leaves to the solver.
 *
 * ELK's own layering minimises total edge length, which answers a different
 * question: on the agent template it put a boot target three columns out from
 * the application booting it, and a console handler three columns past the
 * sequence calling it — both one hop away. So this is handed over as a layer
 * constraint, and a column means hops from the way in.
 *
 * Longest path from a node nothing reaches, over the edges that MOVE work: flow
 * (which includes boot) and the holds that carry structure, so a server sits
 * right of the root that boots it, the router it mounts right of the server, and
 * the handler right of the router. That is the order the manifest reads in, and
 * reproducing it is the whole job of a column.
 *
 * `shape` and `data` edges are excluded: a type reference and a state read say
 * nothing about what runs before what. Cycles are cut at the first repeat rather
 * than refused — two sequences that invoke each other are a legal application,
 * and a layout that threw on one would be a picture you cannot open.
 */
export function assignRanks(
  graph: ModuleGraph,
  /** The edges to rank over. Defaults to every edge, but a view passes the ones
   *  it DRAWS: a column the reader cannot see a reason for is worse than no
   *  column, and an ambient hold is collapsed to a name rather than a line. */
  edges: readonly GraphEdge[] = graph.edges,
): Map<string, number> {
  const ranks = new Map<string, number>();
  const out = new Map<string, string[]>();
  const hasIncoming = new Set<string>();
  for (const edge of edges) {
    if (edge.class === "shape" || edge.class === "data") continue;
    if (!edge.to || edge.to === edge.from) continue;
    out.set(edge.from, [...(out.get(edge.from) ?? []), edge.to]);
    hasIncoming.add(edge.to);
  }

  const visit = (id: string, rank: number, seen: Set<string>): void => {
    if (seen.has(id)) return;
    if ((ranks.get(id) ?? -1) >= rank) return;
    ranks.set(id, rank);
    const next = new Set(seen).add(id);
    for (const to of out.get(id) ?? []) visit(to, rank + 1, next);
  };

  // Roots of the flow first — a node nothing reaches — then anything left over,
  // which is a member of a cycle or reachable only from one. Both get a column
  // rather than dropping off the canvas.
  for (const node of graph.nodes) {
    if (!hasIncoming.has(node.id)) visit(node.id, 0, new Set());
  }
  for (const node of graph.nodes) {
    if (!ranks.has(node.id)) visit(node.id, 0, new Set());
  }
  return ranks;
}

/** Nodes a view draws as boxes of their own: everything the module declares
 *  except what is owned by another box — an inline child and a `with:`-scoped
 *  resource are drawn INSIDE their owner, so they are never peers. */
export function topLevelNodes(graph: ModuleGraph): GraphNode[] {
  return graph.nodes.filter((n) => n.ownership !== "inline" && n.ownership !== "scoped");
}
