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
  // Identity is needed so x-telo-ref constraints resolve to a capability (which
  // classifies a port as edge vs picker).
  reg.registerModuleIdentity("std", "demo");
  reg.registerDefinition(
    definition("Worker", "Telo.Runnable", { uses: { "x-telo-ref": "std/demo#Conf" } }),
  );
  reg.registerDefinition(definition("Conf", "Telo.Provider"));
  return reg;
}

function kind(
  fullKind: string,
  capability: string,
  schema: Record<string, unknown> = {},
): AvailableKind {
  const [alias, kindName] = fullKind.split(".");
  return { fullKind, alias, kindName, capability, schema };
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
  it("partitions nodes vs strip; targets is an edge port, ambient refs are picker ports", () => {
    const model = buildApplicationCanvasModel(viewData(), registry(), ["w"]);

    expect(model.appName).toBe("app");
    // Application root + the runnable node; the provider lands in the strip.
    expect(model.nodes.map((n) => n.name).sort()).toEqual(["app", "w"]);
    expect(model.nodes.find((n) => n.isRoot)?.name).toBe("app");
    expect(model.stripItems.map((n) => n.name)).toEqual(["c"]);

    // The Application's `targets` is an ordinary array-of-refs edge port: one
    // filled slot wired to `w`, plus the trailing add slot.
    expect(model.nodes.find((n) => n.isRoot)?.ports).toEqual([
      {
        key: "targets[]",
        label: "targets",
        flavor: "edge",
        refs: ["telo#Runnable", "telo#Service"],
        capabilities: ["Telo.Runnable", "Telo.Service"],
        slots: [{ concretePath: "targets[0]", target: "w" }],
        addPath: "targets[1]",
      },
    ]);

    // The Worker's ref to the provider is a picker port (no edge), with the
    // matching ambient resource offered as a candidate.
    expect(model.nodes.find((n) => n.name === "w")?.ports).toEqual([
      {
        key: "uses",
        label: "uses",
        flavor: "picker",
        refs: ["std/demo#Conf"],
        capabilities: ["Telo.Provider"],
        slots: [{ concretePath: "uses", target: "c" }],
        candidates: ["c"],
      },
    ]);

    // Only the target edge is drawn; the picker port draws none.
    expect(model.edges).toEqual([
      expect.objectContaining({ from: "app", to: "w", fromPath: "targets[0]" }),
    ]);
  });

  it("drops target edges that don't resolve to a node", () => {
    const model = buildApplicationCanvasModel(viewData(), registry(), ["w", "ghost"]);
    expect(model.edges.filter((e) => e.from === "app").map((e) => e.to)).toEqual(["w"]);
  });

  it("normalizes !ref sentinel targets to names", () => {
    const model = buildApplicationCanvasModel(viewData(), registry(), [
      makeTaggedSentinel("ref", "w"),
    ]);
    expect(model.nodes.find((n) => n.isRoot)?.ports?.[0].slots).toEqual([
      { concretePath: "targets[0]", target: "w" },
    ]);
    expect(model.edges).toContainEqual(
      expect.objectContaining({ from: "app", to: "w", fromPath: "targets[0]" }),
    );
  });

  it("renders sequence steps as node sub-rows and anchors edges per step", () => {
    const SEQ_SCHEMA: Record<string, unknown> = {
      type: "object",
      properties: {
        steps: {
          "x-telo-topology-role": "steps",
          type: "array",
          items: {
            oneOf: [
              {
                title: "Invoke",
                type: "object",
                required: ["name", "invoke"],
                properties: {
                  name: { type: "string" },
                  invoke: { "x-telo-topology-role": "invoke" },
                },
              },
            ],
          },
        },
      },
    };

    const reg = new AnalysisRegistry();
    reg.registerDefinition(definition("Seq", "Telo.Runnable"));
    reg.registerDefinition(definition("Act", "Telo.Invocable"));

    const root = appManifest();
    const manifest: ApplicationManifest = {
      ...root,
      targets: ["seq"],
      resources: [
        moduleRootResource(root),
        {
          kind: "demo.Seq",
          name: "seq",
          fields: {
            steps: [
              { name: "first", invoke: { kind: "demo.Act", name: "a" } },
              { name: "second", invoke: { kind: "demo.Act", name: "b" } },
            ],
          },
        },
        { kind: "demo.Act", name: "a", fields: {} },
        { kind: "demo.Act", name: "b", fields: {} },
      ],
    };
    const kinds = new Map<string, AvailableKind>([
      ["Telo.Application", moduleRootKind(root)],
      ["demo.Seq", kind("demo.Seq", "Telo.Runnable", SEQ_SCHEMA)],
      ["demo.Act", kind("demo.Act", "Telo.Invocable")],
    ]);

    const model = buildApplicationCanvasModel(
      { manifest, kinds, sourceFiles: [] },
      reg,
      ["seq"],
    );

    const seq = model.nodes.find((n) => n.name === "seq");
    expect(seq?.steps).toEqual([
      { path: "steps[0]", name: "first", detail: "a", depth: 0 },
      { path: "steps[1]", name: "second", detail: "b", depth: 0 },
    ]);

    // Each invoke edge anchors to the step it came from, not the outer handle.
    const refEdges = model.edges.filter((e) => e.label === "invoke");
    expect(refEdges).toEqual([
      expect.objectContaining({ from: "seq", to: "a", fromStepPath: "steps[0]" }),
      expect.objectContaining({ from: "seq", to: "b", fromStepPath: "steps[1]" }),
    ]);
  });

  it("descends into loop bodies and anchors edges to the nested invoke step", () => {
    // while/do variant whose body holds the real invokes — mirrors chat-console.
    const SEQ_SCHEMA: Record<string, unknown> = {
      type: "object",
      $defs: {
        step: {
          type: "object",
          properties: { name: { type: "string" } },
          oneOf: [
            {
              title: "invoke",
              required: ["invoke"],
              properties: { invoke: { "x-telo-topology-role": "invoke" } },
            },
            {
              title: "while/do",
              required: ["while", "do"],
              properties: {
                while: { "x-telo-topology-role": "predicate", type: "boolean" },
                do: {
                  "x-telo-topology-role": "branch",
                  type: "array",
                  items: { $ref: "#/$defs/step" },
                },
              },
            },
          ],
        },
      },
      properties: {
        steps: {
          "x-telo-topology-role": "steps",
          type: "array",
          items: { $ref: "#/$defs/step" },
        },
      },
    };

    const reg = new AnalysisRegistry();
    reg.registerDefinition(definition("Seq", "Telo.Runnable"));
    reg.registerDefinition(definition("Act", "Telo.Invocable"));

    const root = appManifest();
    const manifest: ApplicationManifest = {
      ...root,
      targets: ["seq"],
      resources: [
        moduleRootResource(root),
        {
          kind: "demo.Seq",
          name: "seq",
          fields: {
            steps: [
              {
                name: "Loop",
                while: "true",
                do: [
                  { name: "Stream", invoke: { kind: "demo.Act", name: "a" } },
                  { name: "Print", invoke: { kind: "demo.Act", name: "b" } },
                ],
              },
            ],
          },
        },
        { kind: "demo.Act", name: "a", fields: {} },
        { kind: "demo.Act", name: "b", fields: {} },
      ],
    };
    const kinds = new Map<string, AvailableKind>([
      ["Telo.Application", moduleRootKind(root)],
      ["demo.Seq", kind("demo.Seq", "Telo.Runnable", SEQ_SCHEMA)],
      ["demo.Act", kind("demo.Act", "Telo.Invocable")],
    ]);

    const model = buildApplicationCanvasModel(
      { manifest, kinds, sourceFiles: [] },
      reg,
      ["seq"],
    );

    // The loop step plus its two nested invokes, indented a level deeper.
    expect(model.nodes.find((n) => n.name === "seq")?.steps).toEqual([
      { path: "steps[0]", name: "Loop", detail: "while", depth: 0 },
      { path: "steps[0].do[0]", name: "Stream", detail: "a", depth: 1 },
      { path: "steps[0].do[1]", name: "Print", detail: "b", depth: 1 },
    ]);

    // Edges anchor to the deepest (nested) step, not the enclosing loop.
    const refEdges = model.edges.filter((e) => e.label === "invoke");
    expect(refEdges).toEqual([
      expect.objectContaining({ from: "seq", to: "a", fromStepPath: "steps[0].do[0]" }),
      expect.objectContaining({ from: "seq", to: "b", fromStepPath: "steps[0].do[1]" }),
    ]);
  });

  it("builds the same canvas for a Library, with no target edges", () => {
    const model = buildApplicationCanvasModel(libraryViewData(), registry(), []);

    // Same node/strip partition as the Application; the root is the Library.
    expect(model.nodes.map((n) => n.name).sort()).toEqual(["lib", "w"]);
    const root = model.nodes.find((n) => n.isRoot);
    expect(root?.name).toBe("lib");
    expect(root?.capability).toBe("Telo.Library");
    expect(model.stripItems.map((n) => n.name)).toEqual(["c"]);
    // A Library root has no `targets` port, and the ambient ref is a picker
    // port — so no edges are drawn at all.
    expect(root?.ports ?? []).toEqual([]);
    expect(model.edges).toEqual([]);
    expect(model.nodes.find((n) => n.name === "w")?.ports?.[0].flavor).toBe("picker");
  });
});
