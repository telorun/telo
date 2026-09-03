import type { GraphEdge, GraphNode, ModuleGraph } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import { nodesReaching, offCanvasNodes } from "./off-canvas";

const node = (id: string, over: Partial<GraphNode> = {}): GraphNode =>
  ({
    id,
    kind: "x.Kind",
    name: id,
    ownership: "named",
    ports: [],
    rows: [],
    rowArrays: [],
    ...over,
  }) as GraphNode;

const edge = (from: string, to: string, over: Partial<GraphEdge> = {}): GraphEdge =>
  ({
    id: `${from}->${to}`,
    from,
    to,
    toName: to,
    class: "flow",
    use: ["call"],
    slot: "slot",
    path: "slot",
    ...over,
  }) as GraphEdge;

const graphOf = (nodes: GraphNode[], edges: GraphEdge[]): ModuleGraph =>
  ({
    nodes,
    edges,
    regions: [],
    kinds: [],
    nodeById: (id: string) => nodes.find((n) => n.id === id),
    edgesFrom: (id: string) => edges.filter((e) => e.from === id),
    edgesTo: (id: string) => edges.filter((e) => e.to === id),
  }) as ModuleGraph;

describe("what leaves the canvas", () => {
  it("takes a provider and a named shape nothing draws a line to", () => {
    const graph = graphOf(
      [
        node("app", { root: true, ownership: "root" }),
        node("query", { capability: "Telo.Invocable" }),
        node("chatDb", { capability: "Telo.Provider" }),
        node("Rows", { capability: "Telo.Type" }),
      ],
      // The hold and the type reference are the edges the canvas never draws.
      [edge("query", "chatDb", { class: "holds", use: ["dependency"] })],
    );
    const off = offCanvasNodes(graph, [edge("app", "query", { boot: true })]);
    expect(off.providers.map((n) => n.id)).toEqual(["chatDb"]);
    expect(off.types.map((n: { id: string }) => n.id)).toEqual(["Rows"]);
    expect([...off.ids]).toEqual(["Rows", "chatDb"]);
  });

  it("KEEPS a provider control transfers to — the line has to point at something", () => {
    // `Ai.Model` declares `capability: Telo.Provider` and is genuinely called.
    const graph = graphOf(
      [node("agent", { capability: "Telo.Invocable" }), node("model", { capability: "Telo.Provider" })],
      [],
    );
    const off = offCanvasNodes(graph, [edge("agent", "model")]);
    expect(off.providers).toEqual([]);
    expect(off.ids.size).toBe(0);
  });

  it("keeps a resource that is neither held nor a shape, however little reaches it", () => {
    // An unwired declaration stays on the canvas: hiding it would make a
    // collapse elsewhere silently remove something nobody linked to it.
    const graph = graphOf([node("orphan", { capability: "Telo.Runnable" })], []);
    expect(offCanvasNodes(graph, []).ids.size).toBe(0);
  });

  it("never takes an owned declaration — it has nowhere else to be", () => {
    const graph = graphOf(
      [
        node("owner", { capability: "Telo.Runnable" }),
        node("inline", { capability: "Telo.Provider", ownership: "inline", owner: "owner" }),
        node("scoped", { capability: "Telo.Provider", ownership: "scoped", owner: "owner" }),
      ],
      [],
    );
    expect(offCanvasNodes(graph, []).ids.size).toBe(0);
  });

  it("takes an imported instance however much control transfers to it", () => {
    // Unlike an ambient hold, this does not turn on whether a line reaches it:
    // it is another module's declaration, and there is nothing to do to it here
    // beyond point at it.
    const graph = graphOf(
      [
        node("app", { root: true, ownership: "root" }),
        node("writeLine", { capability: "Telo.Invocable", external: true, module: "console" }),
      ],
      [],
    );
    const off = offCanvasNodes(graph, [edge("app", "writeLine", { boot: true })]);
    expect(off.imported.map((n) => n.id)).toEqual(["writeLine"]);
    expect([...off.ids]).toEqual(["writeLine"]);
  });

  it("never takes an imported declaration owned by another box", () => {
    const graph = graphOf(
      [
        node("owner", { capability: "Telo.Runnable", external: true, module: "lib" }),
        node("child", {
          capability: "Telo.Invocable",
          external: true,
          module: "lib",
          ownership: "inline",
          owner: "owner",
        }),
      ],
      [],
    );
    expect(offCanvasNodes(graph, []).imported.map((n) => n.id)).toEqual(["owner"]);
  });

  it("says nothing about a node whose capability did not resolve", () => {
    const graph = graphOf([node("mystery", { unknownKind: true })], []);
    expect(offCanvasNodes(graph, []).ids.size).toBe(0);
  });
});

describe("what a drawer selection rings", () => {
  it("names every box that reaches it, through the edge the canvas does not draw", () => {
    const graph = graphOf(
      [
        node("read", { capability: "Telo.Invocable" }),
        node("write", { capability: "Telo.Invocable" }),
        node("idle", { capability: "Telo.Invocable" }),
        node("chatDb", { capability: "Telo.Provider" }),
      ],
      [
        edge("read", "chatDb", { class: "holds", use: ["dependency"] }),
        edge("write", "chatDb", { class: "holds", use: ["dependency"] }),
      ],
    );
    expect([...nodesReaching(graph, "chatDb")].sort()).toEqual(["read", "write"]);
  });

  it("rings nothing when nothing is selected", () => {
    expect(nodesReaching(graphOf([], []), undefined).size).toBe(0);
  });
});
