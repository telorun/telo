import { AnalysisRegistry } from "@telorun/analyzer";
import type { ResourceDefinition } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { moduleRootKind, moduleRootResource } from "../../../application-adapter";
import type {
  ApplicationManifest,
  AvailableKind,
  LibraryManifest,
  ModuleViewData,
} from "../../../model";
import { buildApplicationCanvasModel } from "./application-canvas-model";

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

function registry(): AnalysisRegistry {
  const reg = new AnalysisRegistry();
  reg.registerDefinition(definition("Worker", "Telo.Runnable", { uses: { "x-telo-ref": "demo#Conf" } }));
  reg.registerDefinition(definition("Conf", "Telo.Provider"));
  return reg;
}

function kind(fullKind: string, capability: string): AvailableKind {
  const [alias, kindName] = fullKind.split(".");
  return { fullKind, alias, kindName, capability, schema: {} };
}

function appManifest(): ApplicationManifest {
  return {
    kind: "Application",
    filePath: "/app/telo.yaml",
    metadata: { name: "app" },
    imports: [],
    targets: ["w"],
    resources: [],
  };
}

function viewData(): ModuleViewData {
  const root = appManifest();
  const manifest: ApplicationManifest = {
    ...root,
    resources: [
      moduleRootResource(root),
      { kind: "demo.Worker", name: "w", fields: { uses: { kind: "demo.Conf", name: "c" } } },
      { kind: "demo.Conf", name: "c", fields: {} },
    ],
  };

  const kinds = new Map<string, AvailableKind>([
    ["Telo.Application", moduleRootKind(root)],
    ["demo.Worker", kind("demo.Worker", "Telo.Runnable")],
    ["demo.Conf", kind("demo.Conf", "Telo.Provider")],
  ]);

  return { manifest, kinds, sourceFiles: [] };
}

/** A Library view with the same resources but no targets. */
function libraryViewData(): ModuleViewData {
  const root: LibraryManifest = {
    kind: "Library",
    filePath: "/lib/telo.yaml",
    metadata: { name: "lib" },
    imports: [],
    resources: [],
  };
  const manifest: LibraryManifest = {
    ...root,
    resources: [
      moduleRootResource(root),
      { kind: "demo.Worker", name: "w", fields: { uses: { kind: "demo.Conf", name: "c" } } },
      { kind: "demo.Conf", name: "c", fields: {} },
    ],
  };
  const kinds = new Map<string, AvailableKind>([
    ["Telo.Library", moduleRootKind(root)],
    ["demo.Worker", kind("demo.Worker", "Telo.Runnable")],
    ["demo.Conf", kind("demo.Conf", "Telo.Provider")],
  ]);
  return { manifest, kinds, sourceFiles: [] };
}

describe("buildApplicationCanvasModel", () => {
  it("partitions nodes vs strip and wires target + ref edges", () => {
    const model = buildApplicationCanvasModel(viewData(), registry(), ["w"]);

    expect(model.appName).toBe("app");
    // Application root + the runnable node; the provider lands in the strip.
    expect(model.nodes.map((n) => n.name).sort()).toEqual(["app", "w"]);
    expect(model.nodes.find((n) => n.isRoot)?.name).toBe("app");
    expect(model.stripItems.map((n) => n.name)).toEqual(["c"]);

    // One Application→target edge; the ref to the provider is a chip, not an edge.
    expect(model.edges).toContainEqual({ from: "app", to: "w", label: "target" });
    expect(model.edges).toHaveLength(1);
    expect(model.chips).toEqual([{ on: "w", target: "c", label: "uses", fromPath: "uses" }]);
    expect(model.targets).toEqual(["w"]);
  });

  it("drops target edges that don't resolve to a node", () => {
    const model = buildApplicationCanvasModel(viewData(), registry(), ["w", "ghost"]);
    expect(model.edges.filter((e) => e.label === "target").map((e) => e.to)).toEqual(["w"]);
  });

  it("normalizes !ref sentinel targets to names", () => {
    const model = buildApplicationCanvasModel(viewData(), registry(), [
      makeTaggedSentinel("ref", "w"),
    ]);
    expect(model.targets).toEqual(["w"]);
    expect(model.edges).toContainEqual({ from: "app", to: "w", label: "target" });
  });

  it("builds the same canvas for a Library, with no target edges", () => {
    const model = buildApplicationCanvasModel(libraryViewData(), registry(), []);

    // Same node/strip partition as the Application; the root is the Library.
    expect(model.nodes.map((n) => n.name).sort()).toEqual(["lib", "w"]);
    const root = model.nodes.find((n) => n.isRoot);
    expect(root?.name).toBe("lib");
    expect(root?.capability).toBe("Telo.Library");
    expect(model.stripItems.map((n) => n.name)).toEqual(["c"]);
    // No targets → no target edges; ref chips still surface.
    expect(model.targets).toEqual([]);
    expect(model.edges.filter((e) => e.label === "target")).toEqual([]);
    expect(model.chips).toEqual([{ on: "w", target: "c", label: "uses", fromPath: "uses" }]);
  });
});
