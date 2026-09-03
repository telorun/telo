import type { GraphKind, GraphNode, ModuleGraph } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import {
  drawerGroups,
  groupTotal,
  isEmpty,
  kindPlaneIsSoleContent,
} from "./drawer-groups";
import { offCanvasNodes } from "./off-canvas";

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

const kind = (id: string, own: boolean): GraphKind =>
  ({ id, name: id, own, instances: [] }) as unknown as GraphKind;

const graphOf = (nodes: GraphNode[], kinds: GraphKind[] = []): ModuleGraph =>
  ({
    nodes,
    kinds,
    edges: [],
    regions: [],
    nodeById: (id: string) => nodes.find((n) => n.id === id),
    edgesFrom: () => [],
    edgesTo: () => [],
  }) as unknown as ModuleGraph;

/** A module with one of everything the drawer files. */
const workspace = () =>
  graphOf(
    [
      node("app", { root: true, ownership: "root" }),
      node("chatLoop", { capability: "Telo.Runnable" }),
      node("chatDb", { capability: "Telo.Provider" }),
      node("Rows", { capability: "Telo.Type" }),
      node("writeLine", { capability: "Telo.Invocable", external: true, module: "console" }),
      node("registryTools", {
        capability: "Telo.Provider",
        external: true,
        module: "ai-mcp",
      }),
    ],
    [kind("app.Own", true), kind("sql.Connection", false), kind("run.Sequence", false)],
  );

const groupsOf = (graph: ModuleGraph, sole = false) =>
  drawerGroups({ graph, offCanvas: offCanvasNodes(graph, []), sole });

describe("what the drawer files where", () => {
  it("splits by WHY a thing is not a box, not by what it is", () => {
    const groups = groupsOf(workspace());
    expect(groups.providers.map((n) => n.id)).toEqual(["chatDb"]);
    expect(groups.types.map((n) => n.id)).toEqual(["Rows"]);
    expect(groups.kinds.map((k) => k.id)).toEqual(["sql.Connection", "run.Sequence"]);
    expect(groups.resources.map((n) => n.id)).toEqual(["registryTools", "writeLine"]);
  });

  it("files an imported instance under what it borrows from, whatever its capability", () => {
    // Not under Providers: the group a declaration is filed in must not depend
    // on whether something happens to call it, and where it was DECLARED is the
    // more specific reason it is not a box.
    const groups = groupsOf(workspace());
    expect(groups.resources.map((n) => n.id)).toContain("registryTools");
    expect(groups.providers.map((n) => n.id)).not.toContain("registryTools");
  });

  it("leaves this module's own boxes and own kinds off it", () => {
    const groups = groupsOf(workspace());
    expect(groups.resources.map((n) => n.id)).not.toContain("chatLoop");
    expect(groups.kinds.map((k) => k.id)).not.toContain("app.Own");
  });

  it("lists this module's own kinds when the drawer IS the canvas", () => {
    // A module that declares kinds and no instances has no other surface, so
    // withholding them would leave it a blank panel.
    const groups = groupsOf(workspace(), true);
    expect(groups.kinds.map((k) => k.id)).toContain("app.Own");
  });

  it("never lists an owned declaration — it is drawn inside its owner", () => {
    const graph = graphOf([
      node("owner", { capability: "Telo.Runnable", external: true, module: "lib" }),
      node("child", {
        capability: "Telo.Invocable",
        external: true,
        module: "lib",
        ownership: "inline",
        owner: "owner",
      }),
    ]);
    expect(groupsOf(graph).resources.map((n) => n.id)).toEqual(["owner"]);
  });

  it("draws no chrome for a module with nothing to file", () => {
    const graph = graphOf([node("app", { root: true, ownership: "root" })]);
    const groups = groupsOf(graph);
    expect(isEmpty(groups)).toBe(true);
    expect(groupTotal(groups)).toBe(0);
  });
});

describe("when the kind plane is the whole content", () => {
  const ids = (graph: ModuleGraph) => offCanvasNodes(graph, []).ids;

  it("is true for a library that declares kinds and no instances", () => {
    const graph = graphOf([node("lib", { root: true, ownership: "root" })], [kind("lib.Webhook", true)]);
    expect(kindPlaneIsSoleContent(graph, ids(graph))).toBe(true);
  });

  it("is FALSE for an empty module, which still draws its root", () => {
    // The one a reader starts from. Reading "no instance boxes" as "kind only"
    // handed the tab to a drawer with nothing in it, and the canvas went blank.
    const graph = graphOf([node("app", { root: true, ownership: "root" })], []);
    expect(kindPlaneIsSoleContent(graph, ids(graph))).toBe(false);
  });

  it("is false as soon as the module declares an instance", () => {
    const graph = graphOf(
      [node("app", { root: true, ownership: "root" }), node("seq", { capability: "Telo.Runnable" })],
      [kind("lib.Webhook", true)],
    );
    expect(kindPlaneIsSoleContent(graph, ids(graph))).toBe(false);
  });

  it("is false when the module wires imported instances, which is its content", () => {
    // Its own declarations are almost nothing and its root IS the application —
    // taking the canvas away would take the boot list with it.
    const graph = graphOf(
      [
        node("app", { root: true, ownership: "root" }),
        node("writeLine", { capability: "Telo.Invocable", external: true, module: "console" }),
      ],
      [kind("app.Own", true)],
    );
    expect(kindPlaneIsSoleContent(graph, ids(graph))).toBe(false);
  });

  it("does not count a dependency's kinds as this module's content", () => {
    const graph = graphOf(
      [node("app", { root: true, ownership: "root" })],
      [kind("sql.Connection", false)],
    );
    expect(kindPlaneIsSoleContent(graph, ids(graph))).toBe(false);
  });
});
