import { AnalysisRegistry } from "@telorun/analyzer";
import type { ResourceDefinition } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { moduleRootKind, moduleRootResource } from "../../../application-adapter";
import type { ApplicationManifest, AvailableKind, ModuleViewData } from "../../../model";
import { buildApplicationCanvasModel } from "./application-canvas-model";
import type { AppCanvasModel, GraphNode } from "./application-canvas-model";
import type { LabeledEdge } from "./overview-graph";
import {
  buildContainmentTree,
  childrenAt,
  findPathTo,
  projectLevel,
  resolveFocusPath,
} from "./containment";

function node(name: string, capability = "Telo.Service", isRoot = false): GraphNode {
  return { kind: `Demo.${name}`, name, capability, ...(isRoot ? { isRoot: true } : {}) };
}

function edge(from: string, to: string, label = "ref"): LabeledEdge {
  return { from, to, label };
}

function model(nodes: GraphNode[], edges: LabeledEdge[]): AppCanvasModel {
  return { appName: "app", nodes, edges, stripItems: [] };
}

/** Child ids of one node — the shape most assertions care about, without
 *  restating the slot labels every time. */
function kids(tree: ReturnType<typeof buildContainmentTree>, id: string): string[] {
  return (tree.childrenOf.get(id) ?? []).map((k) => k.id);
}

/** app ─targets→ server ─mounts→ api ─handler→ handler */
function nestedModel(): AppCanvasModel {
  return model(
    [
      node("app", "Telo.Application", true),
      node("server"),
      node("api", "Telo.Mount"),
      node("handler", "Telo.Invocable"),
    ],
    [edge("app", "server", "targets"), edge("server", "api", "mount"), edge("api", "handler", "handler")],
  );
}

describe("buildContainmentTree", () => {
  it("nests a referenced resource under its referrer", () => {
    const tree = buildContainmentTree(nestedModel());

    expect(tree.rootId).toBe("app");
    expect(kids(tree, "app")).toEqual(["server"]);
    expect(kids(tree, "server")).toEqual(["api"]);
    expect(kids(tree, "api")).toEqual(["handler"]);
  });

  it("hangs an unreferenced resource off the root so it stays reachable", () => {
    const tree = buildContainmentTree(
      model([node("app", "Telo.Application", true), node("server"), node("stray")], [edge("app", "server")]),
    );

    expect(kids(tree, "app")).toEqual(["server", "stray"]);
  });

  it("makes a resource with several referrers a child of each, marked shared", () => {
    const tree = buildContainmentTree(
      model(
        [node("app", "Telo.Application", true), node("a"), node("b"), node("shared")],
        [edge("app", "a"), edge("app", "b"), edge("a", "shared"), edge("b", "shared")],
      ),
    );

    expect(kids(tree, "a")).toEqual(["shared"]);
    expect(kids(tree, "b")).toEqual(["shared"]);
    expect(childrenAt(tree, ["a"])[0].shared).toBe(true);
  });

  it("does not make a self-reference containment", () => {
    const tree = buildContainmentTree(
      model([node("app", "Telo.Application", true), node("loop")], [edge("app", "loop"), edge("loop", "loop")]),
    );

    expect(tree.childrenOf.get("loop")).toBeUndefined();
  });

  it("ignores an edge whose endpoint is not a node (an ambient target)", () => {
    const tree = buildContainmentTree(
      model([node("app", "Telo.Application", true), node("svc")], [edge("app", "svc"), edge("svc", "conn")]),
    );

    expect(tree.childrenOf.get("svc")).toBeUndefined();
  });
});

describe("reference cycles", () => {
  // Attachment used to be by REFERRER COUNT, and every member of a cycle has a
  // referrer — so a mutually-invoking pair was attached to nothing and vanished
  // from the relation entirely: off every level, unroutable, and excluded from
  // the boot list's "not wired up" section, which asks the same question.
  it("attaches a cycle the root cannot reach, rather than dropping it", () => {
    const tree = buildContainmentTree(
      model(
        [node("app", "Telo.Application", true), node("a"), node("b")],
        [edge("a", "b", "invoke"), edge("b", "a", "invoke")],
      ),
    );
    expect(kids(tree, "app")).toEqual(["a"]);
    expect(findPathTo(tree, "a")).toEqual(["a"]);
    // Entered once: `b` is reachable from `a`, so it is not a second root child.
    expect(findPathTo(tree, "b")).toEqual(["a", "b"]);
  });

  it("reaches what hangs off a cycle", () => {
    const tree = buildContainmentTree(
      model(
        [node("app", "Telo.Application", true), node("a"), node("b"), node("leaf")],
        [edge("a", "b", "invoke"), edge("b", "a", "invoke"), edge("b", "leaf", "invoke")],
      ),
    );
    expect(findPathTo(tree, "leaf")).toEqual(["a", "b", "leaf"]);
  });

  it("still nests a node the root CAN reach, cycle or not", () => {
    // The referrer count and reachability agree on an acyclic graph; this is
    // what says the new rule did not flatten the ordinary case.
    const tree = buildContainmentTree(nestedModel());
    expect(kids(tree, "app")).toEqual(["server"]);
    expect(kids(tree, "server")).toEqual(["api"]);
  });

  it("does not attach a cycle the root DOES reach", () => {
    const tree = buildContainmentTree(
      model(
        [node("app", "Telo.Application", true), node("a"), node("b")],
        [edge("app", "a", "targets"), edge("a", "b", "invoke"), edge("b", "a", "invoke")],
      ),
    );
    expect(kids(tree, "app")).toEqual(["a"]);
  });
});

describe("slot labels", () => {
  it("carries the slot each child sits in, since nesting drops the edge that said so", () => {
    const tree = buildContainmentTree(
      model(
        [node("app", "Telo.Application", true), node("server"), node("api", "Telo.Mount")],
        [edge("app", "server", "targets"), edge("server", "api", "mount")],
      ),
    );

    expect(childrenAt(tree, [])[0].via).toEqual(["targets"]);
    expect(childrenAt(tree, ["server"])[0].via).toEqual(["mount"]);
  });

  it("collects every slot when one parent reaches a child from several", () => {
    const tree = buildContainmentTree(
      model(
        [node("app", "Telo.Application", true), node("h", "Telo.Invocable")],
        [edge("app", "h", "targets"), edge("app", "h", "onError")],
      ),
    );

    expect(childrenAt(tree, [])[0].via).toEqual(["targets", "onError"]);
  });

  it("leaves an orphan unlabelled — no slot holds it", () => {
    const tree = buildContainmentTree(
      model([node("app", "Telo.Application", true), node("stray")], []),
    );

    expect(childrenAt(tree, [])[0].via).toEqual([]);
  });
});

describe("childrenAt", () => {
  it("reports the interior size so a view knows what can be opened", () => {
    const tree = buildContainmentTree(nestedModel());

    const [server] = childrenAt(tree, []);
    expect(server.id).toBe("server");
    expect(server.childCount).toBe(1);
    expect(childrenAt(tree, ["server", "api"])[0].childCount).toBe(0);
  });

  it("marks a child already on the path as cyclic instead of descending forever", () => {
    const tree = buildContainmentTree(
      model(
        [node("app", "Telo.Application", true), node("a"), node("b")],
        [edge("app", "a"), edge("a", "b"), edge("b", "a")],
      ),
    );

    const inB = childrenAt(tree, ["a", "b"]);
    expect(inB).toHaveLength(1);
    expect(inB[0]).toMatchObject({ id: "a", cyclic: true });
  });
});

describe("resolveFocusPath", () => {
  it("keeps a path that still holds", () => {
    const tree = buildContainmentTree(nestedModel());

    expect(resolveFocusPath(tree, ["server", "api"])).toEqual(["server", "api"]);
  });

  it("trims to the deepest valid prefix when a link is gone", () => {
    const tree = buildContainmentTree(
      model([node("app", "Telo.Application", true), node("server"), node("api", "Telo.Mount")], [edge("app", "server")]),
    );

    expect(resolveFocusPath(tree, ["server", "api"])).toEqual(["server"]);
  });

  it("drops a path naming a resource that no longer exists", () => {
    const tree = buildContainmentTree(nestedModel());

    expect(resolveFocusPath(tree, ["gone"])).toEqual([]);
  });

  it("cuts a cycle rather than repeating a node", () => {
    const tree = buildContainmentTree(
      model(
        [node("app", "Telo.Application", true), node("a"), node("b")],
        [edge("app", "a"), edge("a", "b"), edge("b", "a")],
      ),
    );

    expect(resolveFocusPath(tree, ["a", "b", "a"])).toEqual(["a", "b"]);
  });
});

describe("findPathTo", () => {
  it("routes to a node named without one", () => {
    const tree = buildContainmentTree(nestedModel());

    expect(findPathTo(tree, "api")).toEqual(["server", "api"]);
  });

  it("takes the shortest route to a shared node", () => {
    // A shared node sits at several routes and none is more true than the
    // others, so the least deep one is the least to hold in your head.
    const tree = buildContainmentTree(
      model(
        [node("app", "Telo.Application", true), node("a"), node("b"), node("helper")],
        [edge("app", "a"), edge("app", "helper"), edge("a", "b"), edge("b", "helper")],
      ),
    );

    expect(findPathTo(tree, "helper")).toEqual(["helper"]);
  });

  it("gives the root the empty path, and nothing for a name it cannot reach", () => {
    const tree = buildContainmentTree(nestedModel());

    expect(findPathTo(tree, "app")).toEqual([]);
    expect(findPathTo(tree, "gone")).toBeNull();
  });
});

describe("projectLevel", () => {
  it("shows the focused node and its children only", () => {
    const m = nestedModel();
    const tree = buildContainmentTree(m);

    const level = projectLevel(m, tree, ["server"]);
    expect(level.nodes.map((n) => n.name)).toEqual(["server", "api"]);
    expect(level.edges).toEqual([edge("server", "api", "mount")]);
  });

  it("re-stamps the focused node as the level root and demotes the module root", () => {
    const m = nestedModel();
    const tree = buildContainmentTree(m);

    const level = projectLevel(m, tree, ["server"]);
    expect(level.nodes.find((n) => n.name === "server")?.isRoot).toBe(true);

    const top = projectLevel(m, tree, []);
    expect(top.nodes.find((n) => n.name === "app")?.isRoot).toBe(true);
  });

  it("keeps the ambient strip at every level", () => {
    const m = { ...nestedModel(), stripItems: [node("conn", "Telo.Provider")] };
    const tree = buildContainmentTree(m);

    expect(projectLevel(m, tree, ["server"]).stripItems).toHaveLength(1);
  });
});

// ── End-to-end over the real model builder ──────────────────────────────────
// The hand-made models above pin the relation; this pins that the relation is
// fed by what the canvas actually derives — the same ports and edges the views
// draw — so the tree and the picture can never disagree about what is connected.


function definition(
  name: string,
  capability: string,
  properties: Record<string, unknown> = {},
): ResourceDefinition {
  return {
    kind: "Telo.Definition",
    metadata: { name, module: "demo" },
    capability,
    schema: { type: "object", properties },
  } as unknown as ResourceDefinition;
}

function availableKind(fullKind: string, capability: string): AvailableKind {
  const [alias, kindName] = fullKind.split(".");
  return { fullKind, alias, kindName, capability, schema: {}, categories: [] };
}

/** app ─targets→ server ─mounts[].mount→ api ─routes[].handler→ handler, plus a
 *  connection the handler holds (ambient — it must not enter the tree). */
function serverWorkspace(): { viewData: ModuleViewData; registry: AnalysisRegistry } {
  const registry = new AnalysisRegistry();
  registry.registerModuleIdentity("std", "demo");
  registry.registerDefinition(
    definition("Server", "Telo.Service", {
      mounts: {
        type: "array",
        items: { type: "object", properties: { mount: { "x-telo-ref": "std/demo#Api" } } },
      },
    }),
  );
  registry.registerDefinition(
    definition("Api", "Telo.Mount", {
      routes: {
        type: "array",
        items: { type: "object", properties: { handler: { "x-telo-ref": "std/demo#Handler" } } },
      },
    }),
  );
  registry.registerDefinition(
    definition("Handler", "Telo.Invocable", { conn: { "x-telo-ref": "std/demo#Conn" } }),
  );
  registry.registerDefinition(definition("Conn", "Telo.Provider"));

  const root: ApplicationManifest = {
    kind: "Application",
    filePath: "/app/telo.yaml",
    metadata: { name: "app" },
    imports: [],
    targets: ["server"],
    resources: [],
  };
  const manifest: ApplicationManifest = {
    ...root,
    resources: [
      moduleRootResource(root),
      {
        kind: "demo.Server",
        name: "server",
        fields: { mounts: [{ mount: { kind: "demo.Api", name: "api" } }] },
      },
      {
        kind: "demo.Api",
        name: "api",
        fields: { routes: [{ handler: { kind: "demo.Handler", name: "listUsers" } }] },
      },
      { kind: "demo.Handler", name: "listUsers", fields: { conn: { kind: "demo.Conn", name: "db" } } },
      { kind: "demo.Conn", name: "db", fields: {} },
    ],
  };
  const kinds = new Map<string, AvailableKind>([
    ["Telo.Application", moduleRootKind(root)],
    ["demo.Server", availableKind("demo.Server", "Telo.Service")],
    ["demo.Api", availableKind("demo.Api", "Telo.Mount")],
    ["demo.Handler", availableKind("demo.Handler", "Telo.Invocable")],
    ["demo.Conn", availableKind("demo.Conn", "Telo.Provider")],
  ]);
  return { viewData: { manifest, kinds, importedConfig: new Map(), sourceFiles: [] }, registry };
}

describe("containment over the real canvas model", () => {
  it("puts an app's targets at the root and a mounted api inside its server", () => {
    const { viewData, registry } = serverWorkspace();
    const m = buildApplicationCanvasModel(viewData, registry, ["server"]);
    const tree = buildContainmentTree(m);

    expect(tree.rootId).toBe("app");
    expect(childrenAt(tree, [])).toMatchObject([{ id: "server", via: ["targets"] }]);
    expect(childrenAt(tree, ["server"]).map((c) => c.id)).toEqual(["api"]);
    expect(childrenAt(tree, ["server", "api"]).map((c) => c.id)).toEqual(["listUsers"]);
  });

  it("keeps an ambient provider out of the relation entirely", () => {
    const { viewData, registry } = serverWorkspace();
    const m = buildApplicationCanvasModel(viewData, registry, ["server"]);
    const tree = buildContainmentTree(m);

    expect(m.stripItems.map((n) => n.name)).toEqual(["db"]);
    expect(tree.nodeById.has("db")).toBe(false);
    expect(childrenAt(tree, ["server", "api", "listUsers"])).toEqual([]);
  });

  it("shows the server and its mounts, and nothing else, one level in", () => {
    const { viewData, registry } = serverWorkspace();
    const m = buildApplicationCanvasModel(viewData, registry, ["server"]);
    const tree = buildContainmentTree(m);

    expect(projectLevel(m, tree, []).nodes.map((n) => n.name)).toEqual(["app", "server"]);
    expect(projectLevel(m, tree, ["server"]).nodes.map((n) => n.name)).toEqual(["server", "api"]);
  });
});
