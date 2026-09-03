import type { GraphEdge, GraphNode, ModuleGraph } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import { resolveMirrors } from "./mirrors";

const node = (id: string, over: Partial<GraphNode> = {}): GraphNode =>
  ({
    id,
    kind: "console.WriteLine",
    name: id,
    ownership: "named",
    ports: [{ slot: "x", refs: [], capabilities: [], array: false, class: "flow", slots: [] }],
    rows: [{ id: "r", kind: "step", path: "steps[0]", array: "steps", index: 0, depth: 0 }],
    rowArrays: [{ field: "steps", kind: "step" }],
    ...over,
  }) as GraphNode;

const edge = (id: string, from: string, to: string): GraphEdge =>
  ({
    id,
    from,
    to,
    toName: to,
    class: "flow",
    use: ["call"],
    slot: "steps[].invoke",
    path: `steps[${id}]`,
  }) as GraphEdge;

const graphOf = (nodes: GraphNode[]): ModuleGraph =>
  ({
    nodes,
    edges: [],
    regions: [],
    kinds: [],
    nodeById: (id: string) => nodes.find((n) => n.id === id),
    edgesFrom: () => [],
    edgesTo: () => [],
  }) as unknown as ModuleGraph;

const graph = () => graphOf([node("seq"), node("other"), node("say"), node("once")]);

describe("a shared resource drawn once", () => {
  it("keeps the FIRST call site's edge and mirrors every later one", () => {
    const drawn = [edge("a", "seq", "say"), edge("b", "seq", "say"), edge("c", "other", "say")];
    const { edges, mirrors } = resolveMirrors(graph(), drawn);
    expect(edges[0].to).toBe("say");
    expect(edges[1].to).toBe(mirrors[0].node.id);
    expect(edges[2].to).toBe(mirrors[1].node.id);
    expect(mirrors.map((m) => m.targetId)).toEqual(["say", "say"]);
  });

  it("leaves a target reached once alone — there is nothing to mirror", () => {
    const drawn = [edge("a", "seq", "once")];
    const { edges, mirrors, fanIn } = resolveMirrors(graph(), drawn);
    expect(edges).toEqual(drawn);
    expect(mirrors).toEqual([]);
    expect(fanIn.size).toBe(0);
  });

  it("says on the ORIGINAL how many reach it, since the lines no longer show it", () => {
    const drawn = [edge("a", "seq", "say"), edge("b", "seq", "say"), edge("c", "other", "say")];
    expect(resolveMirrors(graph(), drawn).fanIn.get("say")).toBe(3);
  });

  it("gives a mirror a name and a kind and NOTHING else", () => {
    // One resource, one configuration, one verdict from the checker — repeating
    // those per call site is worse than the lines they replaced.
    const drawn = [edge("a", "seq", "say"), edge("b", "seq", "say")];
    const [mirror] = resolveMirrors(graph(), drawn).mirrors;
    expect(mirror.node.name).toBe("say");
    expect(mirror.node.kind).toBe("console.WriteLine");
    expect(mirror.node.ports).toEqual([]);
    expect(mirror.node.rows).toEqual([]);
    expect(mirror.node.rowArrays).toEqual([]);
  });

  it("keeps two calls from one box to one target apart", () => {
    const drawn = [edge("a", "seq", "say"), edge("b", "seq", "say"), edge("c", "seq", "say")];
    const ids = resolveMirrors(graph(), drawn).mirrors.map((m) => m.node.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("keeps an edge whose target the graph cannot resolve", () => {
    const drawn = [edge("a", "seq", "ghost"), edge("b", "other", "ghost")];
    const { edges, mirrors } = resolveMirrors(graph(), drawn);
    expect(edges.map((e) => e.to)).toEqual(["ghost", "ghost"]);
    expect(mirrors).toEqual([]);
  });

  it("mirrors each target on its own, never one budget across the picture", () => {
    const drawn = [
      edge("a", "seq", "say"),
      edge("b", "other", "say"),
      edge("c", "seq", "once"),
      edge("d", "other", "once"),
    ];
    const { fanIn } = resolveMirrors(graph(), drawn);
    expect([...fanIn.entries()].sort()).toEqual([
      ["once", 2],
      ["say", 2],
    ]);
  });
});
