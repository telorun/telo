import type { GraphEdge, GraphNode, GraphPort, ModuleGraph } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import { collapsibleProps, isCollapsible, propertyOf, resolveVisibility } from "./collapsible";

const port = (slot: string, over: Partial<GraphPort> = {}): GraphPort => ({
  slot,
  refs: ["telo.Executable"],
  capabilities: ["Telo.Invocable"],
  array: false,
  class: "flow",
  slots: [{ path: slot }],
  ...over,
});

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

const edge = (from: string, to: string, slot: string): GraphEdge =>
  ({
    id: `${from}->${to}:${slot}`,
    from,
    to,
    toName: to,
    class: "flow",
    use: ["call"],
    slot,
    path: slot.replace("[]", "[0]"),
  }) as GraphEdge;

const graphOf = (nodes: GraphNode[], edges: GraphEdge[]): ModuleGraph => ({
  nodes,
  edges,
  regions: [],
  kinds: [],
  nodeById: (id) => nodes.find((n) => n.id === id),
  edgesFrom: (id) => edges.filter((e) => e.from === id),
  edgesTo: (id) => edges.filter((e) => e.to === id),
});

describe("which property a slot belongs to", () => {
  it("reads the top-level field, whatever the slot's shape", () => {
    expect(propertyOf("mounts[].mount")).toBe("mounts");
    expect(propertyOf("notFoundHandler.invoke")).toBe("notFoundHandler");
    expect(propertyOf("connection")).toBe("connection");
    expect(propertyOf("returns[].content.{}.encoder")).toBe("returns");
  });
});

describe("what a box offers to collapse", () => {
  it("gives an HTTP server exactly its two reference-bearing branches", () => {
    const server = node("server", {
      ports: [
        port("notFoundHandler.invoke"),
        port("mounts[].mount", { rowOwned: true, array: true }),
      ],
      rows: [
        { id: "m0", kind: "entry", path: "mounts[0]", array: "mounts", index: 0, depth: 0 },
      ],
      rowArrays: [{ field: "mounts", kind: "entry" }],
    });
    expect(collapsibleProps(server).map((p) => p.key)).toEqual(["notFoundHandler", "mounts"]);
  });

  it("does not repeat a property that is both a port and a row list", () => {
    const api = node("api", {
      ports: [port("routes[].handler", { rowOwned: true, array: true })],
      rows: [{ id: "r0", kind: "entry", path: "routes[0]", array: "routes", index: 0, depth: 0 }],
      rowArrays: [{ field: "routes", kind: "entry" }],
    });
    const props = collapsibleProps(api);
    expect(props).toHaveLength(1);
    expect(props[0]).toMatchObject({ key: "routes", ordered: true });
    expect(props[0].rows).toHaveLength(1);
  });

  it("keeps a nested body in its own branch — a while is part of steps", () => {
    const loop = node("loop", {
      rows: [
        { id: "read", kind: "step", path: "steps[0]", array: "steps", index: 0, depth: 0 },
        { id: "converse", kind: "step", path: "steps[1]", array: "steps", index: 1, depth: 0 },
        {
          id: "ask",
          kind: "step",
          path: "steps[1].do[0]",
          array: "steps[1].do",
          index: 0,
          depth: 1,
          parent: "converse",
        },
      ],
      rowArrays: [{ field: "steps", kind: "step" }],
    });
    const props = collapsibleProps(loop);
    expect(props.map((p) => p.key)).toEqual(["steps"]);
    expect(props[0].rows.map((r) => r.id)).toEqual(["read", "converse", "ask"]);
  });

  it("offers an empty ordered array, which is where the first entry is added", () => {
    const api = node("api", { rowArrays: [{ field: "routes", kind: "entry" }] });
    expect(collapsibleProps(api).map((p) => p.key)).toEqual(["routes"]);
  });
});

describe("which branches earn a collapse control", () => {
  const propOf = (n: GraphNode) => collapsibleProps(n)[0];

  it("offers one on a slot that holds something", () => {
    const n = node("n", { ports: [port("notFoundHandler.invoke", { slots: [{ path: "notFoundHandler.invoke", target: "h" }] })] });
    expect(isCollapsible(propOf(n))).toBe(true);
  });

  it("offers one on a slot holding an inline declaration", () => {
    const n = node("n", { ports: [port("notFoundHandler.invoke", { slots: [{ path: "notFoundHandler.invoke", inline: true }] })] });
    expect(isCollapsible(propOf(n))).toBe(true);
  });

  it("withholds one where collapsing would hide nothing", () => {
    const n = node("n", { ports: [port("notFoundHandler.invoke")] });
    expect(isCollapsible(propOf(n))).toBe(false);
  });

  it("withholds one from an ordered array with no entries", () => {
    const n = node("n", { rowArrays: [{ field: "routes", kind: "entry" }] });
    expect(isCollapsible(propOf(n))).toBe(false);
  });

  it("offers one once that array has an entry", () => {
    const n = node("n", {
      rows: [{ id: "r0", kind: "entry", path: "routes[0]", array: "routes", index: 0, depth: 0 }],
      rowArrays: [{ field: "routes", kind: "entry" }],
    });
    expect(isCollapsible(propOf(n))).toBe(true);
  });

  it("withholds one from a picked branch, filled or not — a hold draws no edge to hide", () => {
    const picked = (slots: GraphPort["slots"]) =>
      node("n", {
        ports: [
          port("connection", { class: "holds", capabilities: ["Telo.Provider"], slots }),
        ],
      });
    expect(isCollapsible(propOf(picked([{ path: "connection" }])))).toBe(false);
    expect(isCollapsible(propOf(picked([{ path: "connection", target: "db" }])))).toBe(false);
  });
});

describe("what disappears when a branch is collapsed", () => {
  /** root → server → api → handler, plus a shared logger both reach. */
  const nodes = [
    node("root", { root: true, ownership: "root" }),
    node("server"),
    node("api"),
    node("handler"),
    node("logger"),
    node("orphan"),
  ];
  const edges = [
    edge("root", "server", "targets[]"),
    edge("server", "api", "mounts[].mount"),
    edge("api", "handler", "routes[].handler"),
    edge("handler", "logger", "logger"),
    edge("root", "logger", "targets[]"),
  ];
  const graph = graphOf(nodes, edges);
  const collapsing = (...keys: string[]) =>
    resolveVisibility({
      graph,
      drawn: edges,
      isCollapsed: (id, prop) => keys.includes(`${id}.${prop}`),
    });

  it("shows everything when nothing is collapsed", () => {
    expect([...collapsing().nodes].sort()).toEqual(
      ["api", "handler", "logger", "orphan", "root", "server"].sort(),
    );
  });

  it("hides the whole branch, not just its first step", () => {
    // Collapsing the server's mounts takes the api AND the handler only that
    // api reached — but not the logger, which the root also references.
    const { nodes: visible } = collapsing("server.mounts");
    expect(visible.has("api")).toBe(false);
    expect(visible.has("handler")).toBe(false);
    expect(visible.has("logger")).toBe(true);
    expect(visible.has("server")).toBe(true);
  });

  it("keeps a node something else still references", () => {
    // The handler reaches the logger, but so does the root's boot list.
    expect(collapsing("handler.logger").nodes.has("logger")).toBe(true);
  });

  it("keeps a node nothing references at all", () => {
    expect(collapsing("server.mounts").nodes.has("orphan")).toBe(true);
  });

  it("keeps the module root, whatever is collapsed", () => {
    expect(collapsing("root.targets").nodes.has("root")).toBe(true);
  });

  it("drops the edges leaving a collapsed branch", () => {
    const { edges: drawn } = collapsing("root.targets");
    expect(drawn.some((e) => e.from === "root")).toBe(false);
    // …and everything the boot list was the only route to goes with them.
    expect(collapsing("root.targets").nodes.has("server")).toBe(false);
  });

  it("takes an owned declaration down with its owner", () => {
    const owner = node("owner");
    const child = node("child", { ownership: "inline", owner: "owner" });
    const g = graphOf([node("root", { root: true, ownership: "root" }), owner, child], [
      edge("root", "owner", "targets[]"),
    ]);
    const visible = resolveVisibility({
      graph: g,
      drawn: [edge("root", "owner", "targets[]")],
      isCollapsed: (id, prop) => id === "root" && prop === "targets",
    });
    expect(visible.nodes.has("owner")).toBe(false);
    expect(visible.nodes.has("child")).toBe(false);
  });
});
