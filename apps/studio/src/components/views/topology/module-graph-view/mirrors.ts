import type { GraphEdge, GraphNode, ModuleGraph } from "@telorun/analyzer";

/**
 * A resource many things call is drawn ONCE and mirrored everywhere else.
 *
 * A shared utility absorbs the picture: in `durable-orders` a `Console.WriteLine`
 * named `say` takes 11 of the module's 22 lines and a `Timer.Delay` takes 4 —
 * two boxes holding two thirds of the edges, every line crossing the whole
 * canvas to reach them. Seven other shipped apps have nothing above three, so
 * this is one shape going wrong rather than general clutter, and the fix has to
 * be local to it.
 *
 * The FIRST call site keeps the real edge to the real box; every later one gets
 * a **mirror** — a dimmed box carrying the target's name and kind and nothing
 * else, placed beside the row that calls it. Ten long lines become ten short
 * ones, and you read a call where it happens rather than following it across the
 * picture.
 *
 * **First means first REPORTED, which is declaration order.** It cannot mean
 * "topmost in the layout": which copy is real decides which edges exist, and the
 * edges decide the layout, so reading it off the layout is circular.
 *
 * **A mirror carries no diagnostics, no ports and no rows.** There is one `say`
 * with one configuration and one verdict from the checker; repeating that
 * eleven times is worse than the lines it replaced. What a mirror is FOR is
 * saying which resource this call reaches, so a name and a kind is all of it —
 * and clicking one selects the real resource, which is where the rest lives.
 *
 * No threshold: the rule is "after the first", so nothing has to be true of a
 * module for it to apply, and there is no number at which the picture jumps.
 */

export interface Mirror {
  /** The stand-in drawn at this call site. */
  node: GraphNode;
  /** Node id of the resource it stands for. */
  targetId: string;
}

export interface MirroredEdges {
  /** The drawn set with every edge past the first re-pointed at its mirror. */
  edges: GraphEdge[];
  mirrors: Mirror[];
  /** Real node id → how many call sites reach it in all, so the one real box
   *  can say so. Only for targets that ended up mirrored. */
  fanIn: ReadonlyMap<string, number>;
}

/** A mirror's id. The edge id is already unique per site, which is what keeps
 *  two calls from the same box to the same target apart. */
const mirrorId = (edge: GraphEdge): string => `${edge.to}::mirror::${edge.id}`;

export function resolveMirrors(graph: ModuleGraph, drawn: readonly GraphEdge[]): MirroredEdges {
  const byTarget = new Map<string, GraphEdge[]>();
  for (const edge of drawn) {
    if (!edge.to) continue;
    byTarget.set(edge.to, [...(byTarget.get(edge.to) ?? []), edge]);
  }

  const edges: GraphEdge[] = [];
  const mirrors: Mirror[] = [];
  const fanIn = new Map<string, number>();

  for (const edge of drawn) {
    const group = edge.to ? byTarget.get(edge.to) : undefined;
    if (!edge.to || !group || group.length < 2 || group[0] === edge) {
      edges.push(edge);
      continue;
    }
    const target = graph.nodeById(edge.to);
    // A target the graph cannot resolve has nothing to mirror; the edge is left
    // as it was rather than pointed at a stand-in for nothing.
    if (!target) {
      edges.push(edge);
      continue;
    }
    const id = mirrorId(edge);
    mirrors.push({
      targetId: edge.to,
      node: {
        ...target,
        id,
        // A mirror is a name and a kind. Everything that made the real box a box
        // is dropped, so nothing it says can disagree with the original.
        ports: [],
        rows: [],
        rowArrays: [],
      },
    });
    fanIn.set(edge.to, group.length);
    edges.push({ ...edge, to: id });
  }

  return { edges, mirrors, fanIn };
}
