import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { buildCallGraph, projectToPairs, resourceId } from "../src/call-graph.js";
import { DefinitionRegistry } from "../src/definition-registry.js";

/** A kind holding one dependency and calling one target — the shape that proves
 *  edges are per-slot rather than per-resource pair. */
const viewDef = {
  kind: "Telo.Definition",
  metadata: { name: "View", module: "cache" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    properties: {
      store: { "x-telo-ref": { kind: "cache.Store", use: "dependency" } },
      invoke: { "x-telo-ref": { kind: "telo.Invocable", use: ["call", "detached"] } },
    },
  },
};

const storeDef = {
  kind: "Telo.Definition",
  metadata: { name: "Store", module: "cache" },
  capability: "Telo.Provider",
  schema: { type: "object", properties: {} },
};

const echoDef = {
  kind: "Telo.Definition",
  metadata: { name: "Echo", module: "test" },
  capability: "Telo.Invocable",
  schema: { type: "object", properties: {} },
};

const criticalDef = {
  kind: "Telo.Definition",
  metadata: { name: "Critical", module: "lease" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    properties: {
      detach: { type: "boolean", default: false },
      invoke: {
        "x-telo-ref": {
          kind: "telo.Executable",
          use: { by: "/detach", cases: { false: "call", true: "detached" } },
        },
      },
    },
  },
};

const sequenceDef = {
  kind: "Telo.Definition",
  metadata: { name: "Sequence", module: "run" },
  capability: "Telo.Runnable",
  schema: {
    type: "object",
    $defs: {
      step: {
        type: "object",
        properties: {
          name: { type: "string" },
          invoke: {
            "x-telo-ref": { kind: "telo.Executable", use: "call", inputs: "/inputs" },
            type: "object",
          },
          inputs: { type: "object" },
          value: { type: "string" },
          if: { type: "boolean", "x-telo-topology-role": "predicate" },
          then: {
            "x-telo-topology-role": "branch",
            type: "array",
            items: { $ref: "#/$defs/step" },
          },
        },
      },
    },
    properties: {
      steps: {
        "x-telo-step-context": { invoke: "invoke", value: "value" },
        type: "array",
        items: { $ref: "#/$defs/step" },
      },
    },
  },
};

function registryOf(...defs: unknown[]): DefinitionRegistry {
  const registry = new DefinitionRegistry();
  for (const def of defs) registry.register(def as never);
  return registry;
}

const ref = (name: string) => makeTaggedSentinel("ref", name);

describe("buildCallGraph — edges are per slot", () => {
  const resources = [
    { kind: "cache.Store", metadata: { name: "Backing" } },
    { kind: "test.Echo", metadata: { name: "Source" } },
    {
      kind: "cache.View",
      metadata: { name: "Cached" },
      store: ref("Backing"),
      invoke: ref("Source"),
    },
  ] as unknown as ResourceManifest[];

  const graph = buildCallGraph(resources, registryOf(viewDef, storeDef, echoDef));
  const view = resourceId("cache.View", "Cached");

  it("emits one edge per ref slot, each with its own use", () => {
    const out = graph.edgesFrom(view);
    expect(out).toHaveLength(2);
    expect(out.find((e) => e.slot === "store")!.use).toEqual(["dependency"]);
    expect(out.find((e) => e.slot === "invoke")!.use).toEqual(["call", "detached"]);
  });

  it("keeps parallel edges to the same target distinct", () => {
    const parallel = [
      { kind: "test.Echo", metadata: { name: "Both" } },
      {
        kind: "cache.View",
        metadata: { name: "Twice" },
        store: ref("Both"),
        invoke: ref("Both"),
      },
    ] as unknown as ResourceManifest[];
    const g = buildCallGraph(parallel, registryOf(viewDef, storeDef, echoDef));
    const edges = g.edgesFrom(resourceId("cache.View", "Twice"));
    expect(edges).toHaveLength(2);
    expect(new Set(edges.map((e) => e.toName)).size).toBe(1);
    expect(edges.map((e) => e.slot).sort()).toEqual(["invoke", "store"]);
  });

  it("controlEdges keeps the call and drops the dependency", () => {
    const control = graph.controlEdges();
    expect(control.map((e) => e.slot)).toEqual(["invoke"]);
  });

  it("projectToPairs collapses the multigraph for init order", () => {
    const pairs = projectToPairs(graph);
    expect(pairs.get(view)).toEqual(
      new Set([resourceId("cache.Store", "Backing"), resourceId("test.Echo", "Source")]),
    );
  });
});

describe("buildCallGraph — x-telo-scope descent", () => {
  const scopedSeqDef = {
    kind: "Telo.Definition",
    metadata: { name: "Scoped", module: "run" },
    capability: "Telo.Runnable",
    schema: {
      type: "object",
      properties: {
        with: { "x-telo-scope": ["/targets"], type: "array", items: { type: "object" } },
        targets: {
          type: "array",
          items: { "x-telo-ref": { kind: "telo.Runnable", use: "call" } },
        },
      },
    },
  };
  const resources = [
    { kind: "cache.Store", metadata: { name: "TopStore" } },
    { kind: "test.Echo", metadata: { name: "Loader" } },
    {
      kind: "run.Scoped",
      metadata: { name: "Outer" },
      with: [
        { kind: "cache.Store", metadata: { name: "localStore" } },
        {
          kind: "cache.View",
          metadata: { name: "inner" },
          store: ref("localStore"),
          invoke: ref("Loader"),
        },
      ],
      targets: [ref("inner")],
    },
  ] as unknown as ResourceManifest[];
  const graph = buildCallGraph(resources, registryOf(scopedSeqDef, echoDef, viewDef, storeDef));
  const outer = resourceId("run.Scoped", "Outer");

  it("resolves an edge into the scope to the SCOPED node, not a module-level name", () => {
    // A `with:`-scoped resource is started by its sequence's `targets:` while
    // never being a top-level resource — it is created when the scope opens, so
    // it takes no part in boot ordering. But it IS a node: dropping it would
    // report it unstartable, which is what `OBSERVED_STATE_NEVER_RUN` would then
    // say about a manifest that works.
    const edges = graph.edgesFrom(outer);
    expect(edges).toHaveLength(1);
    expect(edges[0].toName).toBe("inner");
    expect(edges[0].scoped).toBe(true);
    const target = graph.nodes.get(edges[0].to!)!;
    expect(target).toMatchObject({ type: "resource", name: "inner", scoped: true });
    expect(graph.controlEdges().map((e) => e.toName)).toContain("inner");
  });

  it("walks the scoped resource's own slots, scope-local names first", () => {
    const innerId = graph.edgesFrom(outer)[0].to!;
    const out = graph.edgesFrom(innerId);
    expect(out).toHaveLength(2);
    const store = out.find((e) => e.slot === "store")!;
    const invoke = out.find((e) => e.slot === "invoke")!;
    // `localStore` resolves to the scoped sibling, never a top-level shadow.
    expect(graph.nodes.get(store.to!)).toMatchObject({ name: "localStore", scoped: true });
    expect(invoke.to).toBe(resourceId("test.Echo", "Loader"));
    expect(invoke.use).toEqual(["call", "detached"]);
  });

  it("keeps every scoped node and edge out of init order", () => {
    const pairs = projectToPairs(graph);
    expect(pairs.get(outer)).toEqual(new Set());
    for (const key of pairs.keys()) expect(key.includes("#")).toBe(false);
  });

  it("drops a scoped edge from init order but keeps the resource", () => {
    const graph = buildCallGraph([], registryOf(echoDef));
    expect(projectToPairs(graph).size).toBe(0);
  });

  it("re-resolves a step edge to the scoped node — scope-local names win", () => {
    // Step collection runs before the scope is seen, so without the fix-up a
    // step's `invoke: !ref inner` would resolve to a same-named module-level
    // resource — precisely the shadowing the scope-local-first rule forbids.
    const scopedStepsDef = {
      kind: "Telo.Definition",
      metadata: { name: "WithSteps", module: "run" },
      capability: "Telo.Runnable",
      schema: {
        type: "object",
        properties: {
          with: { "x-telo-scope": ["/steps"], type: "array", items: { type: "object" } },
          steps: {
            "x-telo-step-context": { invoke: "invoke" },
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                invoke: { "x-telo-ref": { kind: "telo.Executable", use: "call" }, type: "object" },
              },
            },
          },
        },
      },
    };
    const resources = [
      // Module-level shadow with the SAME name as the scoped resource.
      { kind: "test.Echo", metadata: { name: "inner" } },
      {
        kind: "run.WithSteps",
        metadata: { name: "Outer" },
        with: [{ kind: "test.Echo", metadata: { name: "inner" } }],
        steps: [{ name: "s", invoke: ref("inner") }],
      },
    ] as unknown as ResourceManifest[];
    const graph = buildCallGraph(resources, registryOf(scopedStepsDef, echoDef));
    const step = graph.steps(resourceId("run.WithSteps", "Outer"))[0];
    const edge = graph.edgesFrom(step.id)[0];
    expect(edge.scoped).toBe(true);
    expect(graph.nodes.get(edge.to!)).toMatchObject({ name: "inner", scoped: true });
  });
});

describe("buildCallGraph — value-tree discovery", () => {
  it("emits a nested edge for a ref no annotation anticipated, conservatively", () => {
    const bareDef = {
      kind: "Telo.Definition",
      metadata: { name: "Bare", module: "test" },
      capability: "Telo.Invocable",
      schema: { type: "object", properties: { config: { type: "object" } } },
    };
    const resources = [
      { kind: "test.Echo", metadata: { name: "Hidden" } },
      { kind: "test.Bare", metadata: { name: "Holder" }, config: { deep: ref("Hidden") } },
    ] as unknown as ResourceManifest[];
    const graph = buildCallGraph(resources, registryOf(bareDef, echoDef));
    const edges = graph.edgesFrom(resourceId("test.Bare", "Holder"));
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      toName: "Hidden",
      nested: true,
      use: [],
      path: "config.deep",
    });
    // Conservative in both directions: reachability sees it…
    expect(graph.controlEdges()).toContain(edges[0]);
    // …and init order does not (not an injection site).
    expect(projectToPairs(graph).get(resourceId("test.Bare", "Holder"))).toEqual(new Set());
  });
});

describe("buildCallGraph — case-map selectors", () => {
  const registry = registryOf(criticalDef, echoDef);
  const target = { kind: "test.Echo", metadata: { name: "Body" } };

  it("resolves the use from a literal selector", () => {
    const resources = [
      target,
      { kind: "lease.Critical", metadata: { name: "L" }, detach: true, invoke: ref("Body") },
    ] as unknown as ResourceManifest[];
    const edge = buildCallGraph(resources, registry).edgesFrom(
      resourceId("lease.Critical", "L"),
    )[0];
    expect(edge.use).toEqual(["detached"]);
    expect(edge.unresolved).toBeUndefined();
  });

  it("resolves the other case", () => {
    const resources = [
      target,
      { kind: "lease.Critical", metadata: { name: "L" }, detach: false, invoke: ref("Body") },
    ] as unknown as ResourceManifest[];
    const edge = buildCallGraph(resources, registry).edgesFrom(
      resourceId("lease.Critical", "L"),
    )[0];
    expect(edge.use).toEqual(["call"]);
  });

  it("falls back to the schema default when the selector is omitted — the common spelling", () => {
    const resources = [
      target,
      { kind: "lease.Critical", metadata: { name: "L" }, invoke: ref("Body") },
    ] as unknown as ResourceManifest[];
    const edge = buildCallGraph(resources, registry).edgesFrom(
      resourceId("lease.Critical", "L"),
    )[0];
    expect(edge.use).toEqual(["call"]);
    expect(edge.unresolved).toBeUndefined();
  });

  it("reports every case, flags unresolved and says WHY: written in CEL", () => {
    const resources = [
      target,
      {
        kind: "lease.Critical",
        metadata: { name: "L" },
        detach: makeTaggedSentinel("cel", "variables.detach"),
        invoke: ref("Body"),
      },
    ] as unknown as ResourceManifest[];
    const edge = buildCallGraph(resources, registry).edgesFrom(
      resourceId("lease.Critical", "L"),
    )[0];
    expect(edge.use.sort()).toEqual(["call", "detached"]);
    expect(edge.unresolvedReason).toBe("dynamic");
  });

  it("distinguishes an absent selector with no default from a dynamic one", () => {
    const noDefaultDef = structuredClone(criticalDef);
    delete (noDefaultDef.schema.properties.detach as { default?: unknown }).default;
    const resources = [
      target,
      { kind: "lease.Critical", metadata: { name: "L" }, invoke: ref("Body") },
    ] as unknown as ResourceManifest[];
    const edge = buildCallGraph(resources, registryOf(noDefaultDef, echoDef)).edgesFrom(
      resourceId("lease.Critical", "L"),
    )[0];
    expect(edge.unresolvedReason).toBe("absent");
    expect(edge.unresolved).toEqual({
      by: "/detach",
      cases: { false: ["call"], true: ["detached"] },
    });
  });

  it("flags a literal selector matching no case as unmatched", () => {
    const resources = [
      target,
      { kind: "lease.Critical", metadata: { name: "L" }, detach: "maybe", invoke: ref("Body") },
    ] as unknown as ResourceManifest[];
    const edge = buildCallGraph(resources, registry).edgesFrom(
      resourceId("lease.Critical", "L"),
    )[0];
    expect(edge.unresolvedReason).toBe("unmatched");
  });
});

describe("buildCallGraph — step nodes", () => {
  const resources = [
    { kind: "test.Echo", metadata: { name: "A" } },
    { kind: "test.Echo", metadata: { name: "B" } },
    {
      kind: "run.Sequence",
      metadata: { name: "Seq" },
      steps: [
        { name: "first", invoke: ref("A"), inputs: {} },
        { name: "pure", value: "x" },
        {
          name: "branchy",
          if: true,
          then: [{ name: "inner", invoke: ref("B") }],
        },
      ],
    },
  ] as unknown as ResourceManifest[];

  const graph = buildCallGraph(resources, registryOf(sequenceDef, echoDef));
  const seq = resourceId("run.Sequence", "Seq");

  it("mints a node for every step, including a pure one with no edge", () => {
    const steps = graph.steps(seq);
    expect(steps.map((s) => s.name)).toEqual(["first", "pure", "branchy", "inner"]);
    const pure = steps.find((s) => s.name === "pure")!;
    expect(graph.edgesFrom(pure.id)).toEqual([]);
  });

  it("records lexical order, enclosing array and nesting parent", () => {
    const steps = graph.steps(seq);
    const byName = new Map(steps.map((s) => [s.name, s]));
    expect(byName.get("first")).toMatchObject({ index: 0, array: "steps", path: "steps[0]" });
    expect(byName.get("branchy")!.index).toBe(2);
    expect(byName.get("branchy")!.parent).toBeUndefined();
    expect(byName.get("inner")).toMatchObject({
      index: 0,
      array: "steps[2].then",
      path: "steps[2].then[0]",
      parent: byName.get("branchy")!.id,
    });
  });

  it("hangs a step's invoke edge off the STEP node, not the sequence", () => {
    const first = graph.steps(seq).find((s) => s.name === "first")!;
    const edges = graph.edgesFrom(first.id);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      to: resourceId("test.Echo", "A"),
      use: ["call"],
      inputs: "/inputs",
    });
    expect(graph.edgesFrom(seq)).toEqual([]);
  });

  it("attaches a nested step's edge to the innermost step", () => {
    const inner = graph.steps(seq).find((s) => s.name === "inner")!;
    expect(graph.edgesFrom(inner.id).map((e) => e.to)).toEqual([resourceId("test.Echo", "B")]);
  });

  it("projectToPairs excludes $ref-hidden step edges by default — not injection sites", () => {
    expect(projectToPairs(graph).get(seq)).toEqual(new Set());
  });

  it("projectToPairs folds non-injected edges onto the owner when asked", () => {
    expect(projectToPairs(graph, { includeNonInjected: true }).get(seq)).toEqual(
      new Set([resourceId("test.Echo", "A"), resourceId("test.Echo", "B")]),
    );
  });
});

describe("buildCallGraph — boot targets are injection sites", () => {
  // Mirrors the builtin `Telo.Application.targets` shape: a step-context array
  // whose items are INLINE in the schema, so the reference field map reaches
  // them and Phase 5 injects there. Init order must keep these edges — an
  // earlier revision keyed the exclusion on node kind and let an Application
  // initialize before its inline-invoke target existed.
  const appDef = {
    kind: "Telo.Definition",
    metadata: { name: "App", module: "test" },
    capability: "Telo.Template",
    schema: {
      type: "object",
      properties: {
        targets: {
          "x-telo-step-context": { invoke: "invoke", outputType: "outputType" },
          type: "array",
          items: {
            "x-telo-ref": { kind: "telo.Runnable", use: "call" },
            anyOf: [
              { type: "string" },
              {
                type: "object",
                required: ["invoke"],
                properties: {
                  name: { type: "string" },
                  invoke: {
                    "x-telo-ref": { kind: "telo.Executable", use: "call", inputs: "/inputs" },
                    type: "object",
                  },
                  inputs: { type: "object" },
                },
              },
            ],
          },
        },
      },
    },
  };
  const resources = [
    { kind: "test.Echo", metadata: { name: "Plain" } },
    { kind: "test.Echo", metadata: { name: "Inline" } },
    {
      kind: "test.App",
      metadata: { name: "Main" },
      targets: [ref("Plain"), { name: "boot", invoke: ref("Inline"), inputs: {} }],
    },
  ] as unknown as ResourceManifest[];
  const graph = buildCallGraph(resources, registryOf(appDef, echoDef));
  const app = resourceId("test.App", "Main");

  it("does not mint a step node for a bare target ref", () => {
    expect(graph.steps(app).map((s) => s.name)).toEqual(["boot"]);
  });

  it("stamps the inline invoke edge as injected and keeps it in init order", () => {
    const boot = graph.steps(app)[0];
    const edge = graph.edgesFrom(boot.id)[0];
    expect(edge).toMatchObject({ toName: "Inline", injected: true, use: ["call"] });
    expect(projectToPairs(graph).get(app)).toEqual(
      new Set([resourceId("test.Echo", "Plain"), resourceId("test.Echo", "Inline")]),
    );
  });
});
