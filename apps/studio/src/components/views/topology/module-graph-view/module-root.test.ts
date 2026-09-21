import type { GraphEdge, GraphNode, ModuleGraph } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import { leavesModuleRoot, withoutModuleRoot } from "./module-root";

const node = (id: string, over: Partial<GraphNode> = {}): GraphNode =>
  ({ id, kind: "x.Kind", name: id, ownership: "named", ports: [], rows: [], rowArrays: [], ...over }) as GraphNode;

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

describe("the module root on the canvas", () => {
  it("draws no root box and no edge leaving it, and keeps every resource", () => {
    const root = node("app", { root: true, ownership: "root" });
    const nodes = [root, node("server"), node("routes")];
    const edges = [
      edge("app", "server", { boot: true, slot: "targets[]", path: "targets[0]" }),
      edge("server", "routes", { class: "holds", use: ["dependency"] }),
    ];
    const graph = { root, nodes, edges } as unknown as ModuleGraph;

    expect(edges.filter((e) => !leavesModuleRoot(graph, e)).map((e) => e.id)).toEqual([
      "server->routes",
    ]);
    expect([...withoutModuleRoot(graph, new Set(nodes.map((n) => n.id)))]).toEqual([
      "server",
      "routes",
    ]);
  });
});
