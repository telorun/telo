import type { GraphEdge, GraphNode, ModuleGraph } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import { assignRanks, isEntryPoint, topLevelNodes } from "./placement";

function node(id: string, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    kind: extra.kind ?? "x.Kind",
    name: id,
    ownership: extra.ownership ?? "named",
    ports: [],
    rows: [],
    rowArrays: [],
    ...extra,
  } as GraphNode;
}

function edge(from: string, to: string, extra: Partial<GraphEdge> = {}): GraphEdge {
  return {
    id: `${from}->${to}`,
    from,
    to,
    toName: to,
    class: extra.class ?? "flow",
    use: extra.use ?? ["call"],
    slot: "slot",
    path: "slot",
    ...extra,
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

describe("placement", () => {
  it("marks a way IN on the node rather than giving it a lane", () => {
    // A lane pulled a whole chain into itself — a server is a boot target and
    // the router it mounts declares the trigger — and stacked a left-to-right
    // sequence into a column.
    const graph = graphOf(
      [
        node("root", { root: true, ownership: "root" }),
        node("api", { capability: "Telo.Mount" }),
        node("handler", { capability: "Telo.Runnable" }),
      ],
      [edge("api", "handler", { use: ["trigger.inbound"] })],
    );
    expect(isEntryPoint(graph.nodes[1], graph)).toBe(true);
    expect(isEntryPoint(graph.nodes[2], graph)).toBe(false);
    expect(isEntryPoint(graph.nodes[0], graph)).toBe(true);
  });

  it("does not draw inline or scoped children as peers", () => {
    const graph = graphOf(
      [
        node("owner"),
        node("child", { ownership: "inline", owner: "owner" }),
        node("scoped", { ownership: "scoped", owner: "owner" }),
      ],
      [],
    );
    expect(topLevelNodes(graph).map((n) => n.id)).toEqual(["owner"]);
  });
});

describe("ranks", () => {
  it("lays a boot chain out left to right, the order the manifest reads in", () => {
    // root → server → api → handler: the shape of every small application, and
    // the one the ingress lane used to stack into a vertical rail.
    const graph = graphOf(
      [
        node("root", { root: true, ownership: "root" }),
        node("server", { capability: "Telo.Service" }),
        node("api", { capability: "Telo.Mount" }),
        node("handler", { capability: "Telo.Runnable" }),
      ],
      [
        edge("root", "server", { boot: true }),
        edge("server", "api", { class: "holds", use: ["dependency"] }),
        edge("api", "handler", { use: ["trigger.inbound"] }),
      ],
    );
    const ranks = assignRanks(graph);
    expect([ranks.get("root"), ranks.get("server"), ranks.get("api"), ranks.get("handler")]).toEqual(
      [0, 1, 2, 3],
    );
  });

  it("ignores type references and state reads, which order nothing", () => {
    const graph = graphOf(
      [node("a", { capability: "Telo.Runnable" }), node("b", { capability: "Telo.Runnable" })],
      [edge("a", "b", { class: "data", use: [] })],
    );
    const ranks = assignRanks(graph);
    expect(ranks.get("b")).toBe(0);
  });

  it("survives a cycle instead of refusing to lay the module out", () => {
    const graph = graphOf(
      [node("a", { capability: "Telo.Runnable" }), node("b", { capability: "Telo.Runnable" })],
      [edge("a", "b"), edge("b", "a")],
    );
    const ranks = assignRanks(graph);
    expect(ranks.get("a")).toBeGreaterThanOrEqual(0);
    expect(ranks.get("b")).toBeGreaterThanOrEqual(0);
  });

  it("places a node nothing flows into rather than dropping it", () => {
    const graph = graphOf([node("orphan", { capability: "Telo.Runnable" })], []);
    expect(assignRanks(graph).get("orphan")).toBe(0);
  });
});
