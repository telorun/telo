import type { GraphEdge, GraphNode, ModuleGraph } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import { handleOffsets, NODE_WIDTH, ROW_HEIGHT } from "./box-geometry";
import { layoutWithElk } from "./elk-layout";
import { resolveMirrors } from "./mirrors";
import { roundedPath } from "./RoutedEdge";

function node(id: string, over: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    kind: over.kind ?? "x.Kind",
    name: id,
    ownership: "named",
    ports: [],
    rows: [],
    rowArrays: [],
    ...over,
  } as GraphNode;
}

function edge(id: string, from: string, to: string, over: Partial<GraphEdge> = {}): GraphEdge {
  return {
    id,
    from,
    to,
    toName: to,
    class: "flow",
    use: ["call"],
    slot: "steps[].invoke",
    path: "steps[0]",
    ...over,
  } as GraphEdge;
}

function graphOf(nodes: GraphNode[], edges: GraphEdge[]): ModuleGraph {
  return {
    nodes,
    edges,
    regions: [],
    kinds: [],
    nodeById: (id) => nodes.find((n) => n.id === id),
    edgesFrom: (id) => edges.filter((e) => e.from === id),
    edgesTo: (id) => edges.filter((e) => e.to === id),
  };
}

/** A sequence with three steps, each invoking a different resource — the shape
 *  whose edges used to leave the box at one point regardless of the row. */
const seq = node("seq", {
  capability: "Telo.Runnable",
  rows: [0, 1, 2].map((i) => ({
    id: `r${i}`,
    kind: "step" as const,
    name: `step${i}`,
    path: `steps[${i}]`,
    array: "steps",
    index: i,
    depth: 0,
  })),
  rowArrays: [{ field: "steps", kind: "step" as const }],
});
const targets = [0, 1, 2].map((i) => node(`t${i}`, { capability: "Telo.Invocable" }));
const stepEdges = [0, 1, 2].map((i) =>
  edge(`e${i}`, "seq", `t${i}`, { row: `r${i}`, path: `steps[${i}]` }),
);

const open = () => true;
const sourcePathOf = (e: GraphEdge) => (e.row ? e.path : undefined);

describe("layout", () => {
  it("starts each step's edge at that step's own row", async () => {
    const graph = graphOf([seq, ...targets], stepEdges);
    const layout = await layoutWithElk({
      graph,
      isOpen: open,
      ownedBy: new Map(),
      drawn: stepEdges,
      sourcePathOf,
    });

    const box = layout.byId.get("seq")!;
    const offsets = handleOffsets(seq, open);
    for (const i of [0, 1, 2]) {
      const route = layout.routes.get(`e${i}`)!;
      expect(route.length).toBeGreaterThanOrEqual(2);
      // The route's first point is the port, in absolute canvas coordinates.
      // The row it leaves from is the point of this: exact.
      expect(route[0].y).toBeCloseTo(box.y + offsets.get(`steps[${i}]`)!, 0);
      // And it leaves from the box's right edge, within a pixel of rounding.
      expect(Math.abs(route[0].x - (box.x + NODE_WIDTH))).toBeLessThanOrEqual(1);
    }
  });

  it("places a callee to the right of its caller", async () => {
    const graph = graphOf([seq, ...targets], stepEdges);
    const layout = await layoutWithElk({
      graph,
      isOpen: open,
      ownedBy: new Map(),
      drawn: stepEdges,
      sourcePathOf,
    });
    const box = layout.byId.get("seq")!;
    for (const i of [0, 1, 2]) {
      expect(layout.byId.get(`t${i}`)!.x).toBeGreaterThan(box.x);
    }
  });

  it("routes an edge with bend points rather than a straight line through a box", async () => {
    // Three targets stacked in one layer: the edge to the far one has to get
    // around the near ones, which is what an orthogonal route is for.
    const graph = graphOf([seq, ...targets], stepEdges);
    const layout = await layoutWithElk({
      graph,
      isOpen: open,
      ownedBy: new Map(),
      drawn: stepEdges,
      sourcePathOf,
    });
    const withBends = [0, 1, 2].filter((i) => (layout.routes.get(`e${i}`)?.length ?? 0) > 2);
    expect(withBends.length).toBeGreaterThan(0);
  });

  it("lays an owned declaration out inside its owner", async () => {
    const child = node("child", { ownership: "inline", owner: "seq", capability: "Telo.Invocable" });
    const graph = graphOf([seq, child], []);
    const layout = await layoutWithElk({
      graph,
      isOpen: open,
      ownedBy: new Map([["seq", [child]]]),
      drawn: [],
      sourcePathOf,
    });
    const placed = layout.byId.get("child")!;
    expect(placed.parent).toBe("seq");
    expect(placed.depth).toBe(1);
    // Relative to the owner, and below its header — inside, not overlapping.
    expect(placed.y).toBeGreaterThan(0);
  });

  it("is deterministic — the same module lays out the same way", async () => {
    const graph = graphOf([seq, ...targets], stepEdges);
    const once = await layoutWithElk({ graph, isOpen: open, ownedBy: new Map(), drawn: stepEdges, sourcePathOf });
    const twice = await layoutWithElk({ graph, isOpen: open, ownedBy: new Map(), drawn: stepEdges, sourcePathOf });
    expect(twice.placed.map((p) => [p.node.id, p.x, p.y])).toEqual(
      once.placed.map((p) => [p.node.id, p.x, p.y]),
    );
  });
});

describe("the drawn path", () => {
  it("rounds a corner without overshooting a short segment", () => {
    const path = roundedPath([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 40 },
    ]);
    // The corner is 4 away, so the radius clamps to 2 rather than the 8 default.
    expect(path).toContain("Q 4,0");
    expect(path.startsWith("M 0,0")).toBe(true);
  });

  it("is empty for a route with nothing to draw", () => {
    expect(roundedPath([{ x: 1, y: 1 }])).toBe("");
  });
});

/**
 * A column is how many hops a box is from the way in.
 *
 * The shape is the agent template's, reduced to its drawn edges: two boot
 * targets, a sequence calling a console handler and an agent, the agent holding
 * a tool set, and providers reached only through collapsed chips.
 */
describe("what a column means", () => {
  const W = (id: string, capability: string) => node(id, { capability });
  const agentTemplate = () => ({
    nodes: [
      node("root", { root: true, ownership: "root", kind: "Telo.Application" }),
      W("initSchema", "Telo.Runnable"),
      W("chatLoop", "Telo.Runnable"),
      W("readLine", "Telo.Invocable"),
      W("assistant", "Telo.Invocable"),
      W("weatherTools", "Telo.Mount"),
      W("getWeather", "Telo.Invocable"),
      W("chatDb", "Telo.Provider"),
      W("gpt4oMini", "Telo.Provider"),
    ],
    drawn: [
      edge("b1", "root", "initSchema", { boot: true }),
      edge("b2", "root", "chatLoop", { boot: true }),
      edge("s1", "chatLoop", "readLine"),
      edge("s2", "chatLoop", "assistant"),
      edge("a1", "assistant", "gpt4oMini"),
      edge("a2", "assistant", "weatherTools", { class: "holds", use: ["dependency"] }),
      edge("w1", "weatherTools", "getWeather"),
    ],
  });

  const columns = async (nodes: GraphNode[], drawn: GraphEdge[]) => {
    const layout = await layoutWithElk({
      graph: graphOf(nodes, drawn),
      isOpen: () => true,
      ownedBy: new Map(),
      drawn,
      sourcePathOf: () => undefined,
    });
    return new Map(layout.placed.map((p) => [p.node.id, p.x] as const));
  };

  it("puts two boot targets in the SAME column, one above the other", async () => {
    const { nodes, drawn } = agentTemplate();
    const x = await columns(nodes, drawn);
    expect(x.get("initSchema")).toBe(x.get("chatLoop"));
    expect(x.get("initSchema")).toBeGreaterThan(x.get("root")!);
  });

  it("puts everything one hop from a sequence in one column", async () => {
    const { nodes, drawn } = agentTemplate();
    const x = await columns(nodes, drawn);
    expect(x.get("readLine")).toBe(x.get("assistant"));
  });

  it("counts hops, so a longer chain reads further right", async () => {
    const { nodes, drawn } = agentTemplate();
    const x = await columns(nodes, drawn);
    expect(x.get("weatherTools")).toBeGreaterThan(x.get("assistant")!);
    expect(x.get("getWeather")).toBeGreaterThan(x.get("weatherTools")!);
  });

  it("ranks a provider control TRANSFERS to like anything else it reaches", async () => {
    // `gpt4oMini` declares `capability: Telo.Provider` and is genuinely called,
    // so it keeps its box — and its column is its hop distance, where the
    // retired infrastructure band used to pin it past the end of the flow.
    const { nodes, drawn } = agentTemplate();
    const x = await columns(nodes, drawn);
    expect(x.get("gpt4oMini")).toBe(x.get("weatherTools"));
    expect(x.get("gpt4oMini")).toBeLessThan(x.get("getWeather")!);
  });

  it("lays out a cycle rather than refusing it", async () => {
    const nodes = [
      node("root", { root: true, ownership: "root", kind: "Telo.Application" }),
      W("a", "Telo.Invocable"),
      W("b", "Telo.Invocable"),
    ];
    const drawn = [
      edge("boot", "root", "a", { boot: true }),
      edge("ab", "a", "b"),
      edge("ba", "b", "a"),
    ];
    const x = await columns(nodes, drawn);
    expect(x.get("b")).toBeGreaterThan(x.get("a")!);
  });
});

/**
 * The worst shape in the shipped examples: one `Console.WriteLine` reached from
 * eleven steps of one sequence, half the module's drawn edges.
 */
describe("a hub drawn once and mirrored", () => {
  const hub = () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({
      id: `s${i}`,
      kind: "step" as const,
      name: `s${i}`,
      path: `steps[${i}]`,
      array: "steps",
      index: i,
      depth: 0,
    }));
    const nodes = [
      node("root", { root: true, ownership: "root", kind: "Telo.Application" }),
      node("workflow", { capability: "Telo.Runnable", rows }),
      node("say", { capability: "Telo.Invocable" }),
    ];
    const drawn = [
      edge("boot", "root", "workflow", { boot: true }),
      ...rows.map((r, i) => edge(`e${i}`, "workflow", "say", { path: r.path, row: r.id })),
    ];
    return { nodes, drawn, rows };
  };

  const laid = async () => {
    const { nodes, drawn, rows } = hub();
    const graph = graphOf(nodes, drawn);
    const mirrored = resolveMirrors(graph, drawn);
    const layout = await layoutWithElk({
      graph,
      isOpen: () => true,
      ownedBy: new Map(),
      drawn: mirrored.edges,
      extra: mirrored.mirrors.map((m) => m.node),
      sourcePathOf: (e) => (e.row ? rows.find((r) => r.id === e.row)?.path : undefined),
    });
    return { layout, mirrored };
  };

  it("places every mirror, so no call site loses its target", async () => {
    const { layout, mirrored } = await laid();
    expect(mirrored.mirrors).toHaveLength(10);
    for (const m of mirrored.mirrors) expect(layout.byId.has(m.node.id)).toBe(true);
  });

  it("leaves no long line — that was the whole complaint", async () => {
    const { layout } = await laid();
    const spans = [...layout.routes.values()].map((r) => Math.abs(r[r.length - 1].x - r[0].x));
    // One column's worth. Before mirroring, eleven of these crossed the canvas
    // to converge on one box.
    expect(Math.max(...spans)).toBeLessThan(NODE_WIDTH);
  });

  it("keeps the mirrors no taller than a box of the rows they answer to", async () => {
    // Given a box's header and tail a mirror stood four times taller than its
    // own row, so eleven ran three screens past the eleven that called them.
    const { layout, mirrored } = await laid();
    const placed = mirrored.mirrors.map((m) => layout.byId.get(m.node.id)!);
    for (const p of placed) expect(p.height).toBeLessThan(ROW_HEIGHT * 2);
  });

  it("puts the original and its mirrors in one column", async () => {
    const { layout, mirrored } = await laid();
    const real = layout.byId.get("say")!;
    for (const m of mirrored.mirrors) expect(layout.byId.get(m.node.id)!.x).toBe(real.x);
  });
});

