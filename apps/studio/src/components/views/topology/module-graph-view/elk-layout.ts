import type { GraphEdge, GraphNode, ModuleGraph } from "@telorun/analyzer";
import ELK, { type ElkNode, type ElkExtendedEdge } from "elkjs/lib/elk.bundled.js";
import { assignRanks, topLevelNodes } from "./placement";
import {
  contentHeight,
  handleOffsets,
  MIRROR_HEIGHT,
  MIRROR_WIDTH,
  NEST_DEPTH_LIMIT,
  NEST_PAD,
  NODE_WIDTH,
  type IsOpen,
} from "./box-geometry";

/**
 * Layout and edge routing, by ELK.
 *
 * The hand-rolled version placed boxes in columns and let the renderer draw
 * straight-ish edges between them, which failed in the two ways a picture of a
 * real application fails: an edge leaving a step ROW pointed at a box whose
 * vertical position had nothing to do with that row, and every edge crossed
 * whatever boxes lay between its ends. Both are the same missing thing — nobody
 * was solving for position and route together.
 *
 * ELK is given what it needs to solve it: **fixed ports** at the exact y each
 * handle is rendered at (so a step's edge leaves its own row and the target is
 * placed to suit), **hierarchy** for owned declarations (so an inline child is
 * laid out inside its owner rather than by arithmetic here), and **orthogonal
 * routing** (so an edge goes around a box instead of through it).
 *
 * What stays ours is the MEANING: which nodes exist, which edges are drawn, and
 * how far along the flow each one sits. ELK decides geometry and nothing else.
 */

/** One engine per module: it is stateless between calls and constructing it
 *  spins up a worker-ish bundle, which is not free. */
const elk = new ELK();

const LAYOUT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  // Work reads left to right, which is the order the manifest reads in.
  "elk.direction": "RIGHT",
  // Route around boxes rather than through them — the whole reason for ELK.
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.spacing.nodeNodeBetweenLayers": "80",
  "elk.spacing.nodeNode": "28",
  "elk.spacing.edgeNode": "16",
  "elk.spacing.edgeEdge": "12",
  "elk.layered.spacing.edgeNodeBetweenLayers": "24",
  // Crossing minimisation is what pulls a target level with the row that feeds
  // it, once the ports below say where that row is.
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  // Deterministic: the same manifest lays out the same way every time, which is
  // what makes "an unrelated edit moves nothing" true.
  "elk.randomSeed": "1",
  "elk.partitioning.activate": "true",
  // One component, so the partitions above apply to EVERY box. Separated
  // components are packed after layout with no regard for a partition, which
  // put a connection held only through collapsed chips — so with no drawn edge
  // at all — in the leftmost column, ahead of the application that boots the
  // work standing on it.
  "elk.separateConnectedComponents": "false",
};

/**
 * A column is HOP DISTANCE from the way in, and it is pinned rather than hoped
 * for.
 *
 * ELK's default layering minimises total edge length, which is a different
 * question from "how far along the flow is this": on the agent template it put
 * a boot target three columns out from the application that boots it, and a
 * console handler three columns past the sequence that calls it — both one hop
 * away, both drawn as though they were deep in the chain. The ranks were
 * already computed and never handed over.
 *
 * Partitions are ordinal layer constraints — a node in partition `i` is placed
 * before every node in partition `i + 1` — so a node's partition IS its rank.
 */
function partitionsFor(
  graph: ModuleGraph,
  drawn: readonly GraphEdge[],
  extra: readonly GraphNode[],
): Map<string, number> {
  const ranks = assignRanks(graph, drawn);
  const out = new Map<string, number>();
  for (const node of graph.nodes) out.set(node.id, ranks.get(node.id) ?? 0);
  // A mirror has no hop distance of its own — it is not a place work reaches,
  // it is a restatement of one. Its column is one past whoever calls it, which
  // is what puts it beside that row instead of in the target's own column.
  const callerOf = new Map<string, string>();
  for (const edge of drawn) if (edge.to) callerOf.set(edge.to, edge.from);
  for (const node of extra) {
    out.set(node.id, (out.get(callerOf.get(node.id) ?? "") ?? 0) + 1);
  }
  return out;
}

export interface PlacedNode {
  node: GraphNode;
  /** Relative to the parent box for a nested node, absolute otherwise — which is
   *  what xyflow's `parentId` expects. */
  x: number;
  y: number;
  /** Absolute on the canvas, whatever the nesting. What a caller comparing two
   *  layouts needs: a nested box can keep its relative position while its owner
   *  moves, so the relative one says nothing about whether it moved on screen. */
  absoluteX: number;
  absoluteY: number;
  width: number;
  height: number;
  parent?: string;
  depth: number;
}

export interface ModuleGraphLayout {
  placed: PlacedNode[];
  byId: ReadonlyMap<string, PlacedNode>;
  ownedBy: ReadonlyMap<string, GraphNode[]>;
  /** Absolute canvas points an edge is routed through, by edge id. */
  routes: ReadonlyMap<string, { x: number; y: number }[]>;
  width: number;
  height: number;
}

/** The handle an edge leaves from, as the renderer spells it — or undefined when
 *  it docks on the box itself. Mirrors `sourceHandleOf` in the view; passed in
 *  so the layout and the renderer cannot disagree about which port to solve for. */
export type SourcePathOf = (edge: GraphEdge) => string | undefined;

export interface ElkLayoutInput {
  graph: ModuleGraph;
  isOpen: IsOpen;
  ownedBy: ReadonlyMap<string, GraphNode[]>;
  /** Node ids to lay out. A box put away by a collapsed branch is not placed at
   *  all — leaving it in and hiding it afterwards would have the solver reserve
   *  space for something nobody sees. */
  visible?: ReadonlySet<string>;
  /** Edges the view actually draws — routing anything else would spend the
   *  solver's effort on lines nobody sees. */
  drawn: readonly GraphEdge[];
  /** Boxes to place that are not in the graph — the mirrors standing in for a
   *  shared resource at each call site past the first. Laid out like any other
   *  node so the SOLVER puts each one beside the row that reaches it; placing
   *  them by hand would be a second layout mechanism running against ELK's. */
  extra?: readonly GraphNode[];
  sourcePathOf: SourcePathOf;
}

/**
 * A port is a 1px box, and ELK anchors an edge at its CENTRE — so the box is
 * placed half a pixel above the handle it stands for, or every route starts one
 * pixel below the row it left. Small, and exactly the kind of drift that makes a
 * picture look hand-drawn.
 */
const PORT_SIZE = 1;
const portY = (centre: number): number => centre - PORT_SIZE / 2;

/** Port id for a handle, and for a box's own incoming socket. */
const portId = (nodeId: string, path: string): string => `${nodeId}::out::${path}`;
const targetPortId = (nodeId: string): string => `${nodeId}::in`;

export async function layoutWithElk(input: ElkLayoutInput): Promise<ModuleGraphLayout> {
  const { graph, isOpen, ownedBy, drawn, sourcePathOf, visible, extra } = input;
  const extraById = new Map((extra ?? []).map((node) => [node.id, node] as const));
  const shown = (id: string): boolean => !visible || visible.has(id);
  const partitions = partitionsFor(graph, drawn, extra ?? []);

  // Ports must exist on the node before the edge referencing them, and only for
  // handles an edge actually uses: a port ELK is told about but nothing enters
  // still reserves space on the border.
  const usedPorts = new Map<string, Set<string>>();
  for (const edge of drawn) {
    const path = sourcePathOf(edge);
    if (!path) continue;
    const set = usedPorts.get(edge.from) ?? new Set<string>();
    set.add(path);
    usedPorts.set(edge.from, set);
  }

  const buildNode = (node: GraphNode, depth: number): ElkNode => {
    const mirror = extraById.has(node.id);
    const width = mirror ? MIRROR_WIDTH : NODE_WIDTH - depth * 2 * NEST_PAD;
    const own = mirror ? MIRROR_HEIGHT : contentHeight(node, isOpen);
    const children =
      depth < NEST_DEPTH_LIMIT
        ? (ownedBy.get(node.id) ?? []).filter((c) => shown(c.id)).map((c) => buildNode(c, depth + 1))
        : [];
    const offsets = handleOffsets(node, isOpen);

    const ports = [
      // The incoming socket, at the box's own top-left region — the renderer
      // puts the target handle on the left edge.
      {
        id: targetPortId(node.id),
        width: PORT_SIZE,
        height: PORT_SIZE,
        x: 0,
        y: portY(own / 2),
        layoutOptions: { "elk.port.side": "WEST" },
      },
      ...[...(usedPorts.get(node.id) ?? [])].map((path) => ({
        id: portId(node.id, path),
        width: PORT_SIZE,
        height: PORT_SIZE,
        x: width,
        // A handle the box no longer renders (a closed box's row) has no offset;
        // its edge docks on the box, so the port sits at the middle.
        y: portY(offsets.get(path) ?? own / 2),
        layoutOptions: { "elk.port.side": "EAST" },
      })),
    ];

    const elkNode: ElkNode = {
      id: node.id,
      width,
      // A box with children is sized by ELK around them; one without is exactly
      // its content.
      ...(children.length > 0 ? {} : { height: own }),
      ports,
      layoutOptions: {
        "elk.portConstraints": "FIXED_POS",
        ...(children.length > 0
          ? {
              "elk.algorithm": "layered",
              "elk.direction": "RIGHT",
              "elk.padding": `[top=${own},left=${NEST_PAD},bottom=${NEST_PAD},right=${NEST_PAD}]`,
              "elk.spacing.nodeNode": String(NEST_PAD),
            }
          : {}),
        ...(depth === 0
          ? { "elk.partitioning.partition": String(partitions.get(node.id) ?? 0) }
          : {}),
      },
      ...(children.length > 0 ? { children } : {}),
    };
    return elkNode;
  };

  const roots = [...topLevelNodes(graph).filter((n) => shown(n.id)), ...(extra ?? [])].map((n) =>
    buildNode(n, 0),
  );
  const known = new Set<string>();
  const collect = (n: ElkNode): void => {
    known.add(n.id);
    for (const c of n.children ?? []) collect(c);
  };
  for (const r of roots) collect(r);

  const edges: ElkExtendedEdge[] = drawn
    .filter((e) => e.to && known.has(e.from) && known.has(e.to))
    .map((e) => {
      const path = sourcePathOf(e);
      return {
        id: e.id,
        sources: [path ? portId(e.from, path) : e.from],
        targets: [targetPortId(e.to!)],
      };
    });

  const result: ElkNode = await elk.layout({
    id: "root",
    layoutOptions: LAYOUT_OPTIONS,
    children: roots,
    // Declared at the root so a route between a nested box and a top-level one
    // is solved in one coordinate system, which is also the one the canvas draws
    // in.
    edges,
  });

  const placed: PlacedNode[] = [];
  const absolute = new Map<string, { x: number; y: number }>();
  const walk = (n: ElkNode, parent: GraphNode | undefined, depth: number, originX: number, originY: number): void => {
    const node =
      graph.nodeById(n.id) ??
      extraById.get(n.id) ??
      (ownedBy.get(parent?.id ?? "") ?? []).find((c) => c.id === n.id);
    if (!node) return;
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    absolute.set(n.id, { x: originX + x, y: originY + y });
    placed.push({
      node,
      x,
      y,
      absoluteX: originX + x,
      absoluteY: originY + y,
      width: n.width ?? NODE_WIDTH,
      height: n.height ?? (extraById.has(n.id) ? MIRROR_HEIGHT : contentHeight(node, isOpen)),
      depth,
      ...(parent ? { parent: parent.id } : {}),
    });
    for (const child of n.children ?? []) walk(child, node, depth + 1, originX + x, originY + y);
  };
  for (const r of result.children ?? []) walk(r, undefined, 0, 0, 0);

  const routes = new Map<string, { x: number; y: number }[]>();
  for (const edge of result.edges ?? []) {
    const section = (edge as ElkExtendedEdge).sections?.[0];
    if (!section) continue;
    routes.set(edge.id, [
      section.startPoint,
      ...(section.bendPoints ?? []),
      section.endPoint,
    ]);
  }

  return {
    placed,
    byId: new Map(placed.map((p) => [p.node.id, p] as const)),
    ownedBy,
    routes,
    width: result.width ?? 0,
    height: result.height ?? 0,
  };
}
