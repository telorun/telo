import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { buildDependencyGraph, formatCycle } from "../src/dependency-graph.js";
import { AliasResolver } from "../src/alias-resolver.js";
import { DefinitionRegistry } from "../src/definition-registry.js";

const ref = (name: string) => makeTaggedSentinel("ref", name);

const echoDef = {
  kind: "Telo.Definition",
  metadata: { name: "Echo", module: "test" },
  capability: "Telo.Invocable",
  schema: { type: "object", properties: {} },
};

const holderDef = {
  kind: "Telo.Definition",
  metadata: { name: "Holder", module: "test" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    properties: {
      dep: { "x-telo-ref": { kind: "test.Echo", use: "dependency" } },
      shape: { "x-telo-ref": { kind: "Telo.Type", use: "schema" } },
    },
  },
};

const typeDef = {
  kind: "Telo.Definition",
  metadata: { name: "Shape", module: "test" },
  capability: "Telo.Type",
  schema: { type: "object", properties: {} },
};

/** Mirrors the builtin `Telo.Application.targets`: a step-context array whose
 *  items are INLINE in the schema, so the field map reaches them and Phase 5
 *  injects there. */
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
              required: ["ref"],
              properties: {
                ref: { "x-telo-ref": { kind: "telo.Runnable", use: "call" }, type: "object" },
                when: { type: "string" },
              },
            },
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

function registryOf(...defs: unknown[]): DefinitionRegistry {
  const registry = new DefinitionRegistry();
  for (const def of defs) registry.register(def as never);
  return registry;
}

describe("buildDependencyGraph — parity with the pre-graph walker", () => {
  it("orders a dependency edge and ignores a schema edge", () => {
    const resources = [
      {
        kind: "test.Holder",
        metadata: { name: "H" },
        dep: ref("E"),
        shape: ref("S"),
      },
      { kind: "test.Echo", metadata: { name: "E" } },
      { kind: "test.Shape", metadata: { name: "S" } },
    ] as unknown as ResourceManifest[];
    const { order, cycle } = buildDependencyGraph(resources, registryOf(holderDef, echoDef, typeDef));
    expect(cycle).toBeUndefined();
    const names = order!.map((n) => n.name);
    // The dependency target precedes its holder; the Type target is unordered.
    expect(names.indexOf("E")).toBeLessThan(names.indexOf("H"));
    expect(names).toContain("S");
  });

  it("reports a cycle with its path", () => {
    const cyclicDef = {
      kind: "Telo.Definition",
      metadata: { name: "Loop", module: "test" },
      capability: "Telo.Invocable",
      schema: {
        type: "object",
        properties: { dep: { "x-telo-ref": { kind: "test.Loop", use: "dependency" } } },
      },
    };
    const resources = [
      { kind: "test.Loop", metadata: { name: "A" }, dep: ref("B") },
      { kind: "test.Loop", metadata: { name: "B" }, dep: ref("A") },
    ] as unknown as ResourceManifest[];
    const { order, cycle } = buildDependencyGraph(resources, registryOf(cyclicDef));
    expect(order).toBeUndefined();
    expect(cycle!.length).toBeGreaterThanOrEqual(3);
    expect(formatCycle(cycle!)).toContain("Circular dependency detected");
  });

  it("reports each disjoint loop once, the kernel's cycle among them", () => {
    const loopDef = {
      kind: "Telo.Definition",
      metadata: { name: "Loop", module: "test" },
      capability: "Telo.Invocable",
      schema: {
        type: "object",
        properties: { dep: { "x-telo-ref": { kind: "test.Loop", use: "dependency" } } },
      },
    };
    const resources = [
      { kind: "test.Loop", metadata: { name: "Head" }, dep: ref("A") },
      { kind: "test.Loop", metadata: { name: "A" }, dep: ref("B") },
      { kind: "test.Loop", metadata: { name: "B" }, dep: ref("A") },
      { kind: "test.Loop", metadata: { name: "C" }, dep: ref("D") },
      { kind: "test.Loop", metadata: { name: "D" }, dep: ref("E") },
      { kind: "test.Loop", metadata: { name: "E" }, dep: ref("C") },
      { kind: "test.Loop", metadata: { name: "Self" }, dep: ref("Self") },
    ] as unknown as ResourceManifest[];
    const { cycle, cycles } = buildDependencyGraph(resources, registryOf(loopDef));
    expect(cycles!.map((c) => c.map((n) => n.name))).toEqual([
      ["A", "B", "A"],
      ["C", "D", "E", "C"],
      ["Self", "Self"],
    ]);
    expect(cycles![0]).toEqual(cycle);
  });

  it("keeps a scope-declared target out of boot order", () => {
    const scopedDef = {
      kind: "Telo.Definition",
      metadata: { name: "Scoped", module: "test" },
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
      {
        kind: "test.Scoped",
        metadata: { name: "Outer" },
        with: [{ kind: "test.Echo", metadata: { name: "inner" } }],
        targets: [ref("inner")],
      },
    ] as unknown as ResourceManifest[];
    const { order } = buildDependencyGraph(resources, registryOf(scopedDef, echoDef));
    expect(order!.map((n) => n.name)).toEqual(["Outer"]);
  });
});

describe("buildDependencyGraph — boot targets stay ordered (regression)", () => {
  // The exclusion of step edges from init order must key on "is this site a
  // Phase-5 injection site", never on node kind: `Telo.Application.targets` is
  // a step array whose inline items the field map reaches and the kernel
  // injects into. A revision that dropped these edges let an Application
  // initialize before its inline-invoke target existed.
  const resources = [
    {
      kind: "test.App",
      metadata: { name: "Main" },
      targets: [
        ref("Plain"),
        { ref: ref("Gated"), when: "${{ variables.go }}" },
        { name: "boot", invoke: ref("Inline"), inputs: {} },
      ],
    },
    { kind: "test.Echo", metadata: { name: "Plain" } },
    { kind: "test.Echo", metadata: { name: "Gated" } },
    { kind: "test.Echo", metadata: { name: "Inline" } },
  ] as unknown as ResourceManifest[];

  it("orders every target form before the application", () => {
    const { order, cycle } = buildDependencyGraph(resources, registryOf(appDef, echoDef));
    expect(cycle).toBeUndefined();
    const names = order!.map((n) => n.name);
    for (const target of ["Plain", "Gated", "Inline"]) {
      expect(names.indexOf(target), `${target} must precede Main`).toBeLessThan(
        names.indexOf("Main"),
      );
    }
  });
});

describe("buildDependencyGraph — module calls", () => {
  const cel = (source: string) => makeTaggedSentinel("cel", source);

  it("orders a callee before the resource whose expression calls it", () => {
    const resources = [
      { kind: "test.Echo", metadata: { name: "caller" }, value: cel("Self.callee(1)") },
      { kind: "test.Echo", metadata: { name: "callee" } },
    ] as unknown as ResourceManifest[];
    const names = buildDependencyGraph(resources, registryOf(echoDef)).order!.map((n) => n.name);
    expect(names).toEqual(["callee", "caller"]);
  });

  it("reports a body calling itself as a cycle", () => {
    const resources = [
      { kind: "test.Echo", metadata: { name: "loop" }, value: cel("Self.loop(1)") },
    ] as unknown as ResourceManifest[];
    const { order, cycle } = buildDependencyGraph(resources, registryOf(echoDef));
    expect(order).toBeUndefined();
    expect(cycle!.map((n) => n.name)).toEqual(["loop", "loop"]);
  });
});

describe("buildDependencyGraph — creation order", () => {
  /** The entry's alias table, as analysis registers it for `App`. */
  const appAliases = () => {
    const aliases = new AliasResolver();
    aliases.registerUngatedAlias("Self", "App");
    aliases.registerUngatedAlias("App", "App");
    aliases.registerImport("Lib", "Library");
    return aliases;
  };
  const names = (resources: unknown[]) =>
    buildDependencyGraph(resources as ResourceManifest[], registryOf(), appAliases()).order!.map(
      (n) => n.name,
    );

  it("creates an import and a local definition before what is spelled through them", () => {
    // Written in the worst order: every user before the declaration it needs.
    const app = { module: "App" };
    const order = names([
      { kind: "Telo.Application", metadata: { name: "App" } },
      { kind: "Lib.Echo", metadata: { name: "echo", ...app } },
      { kind: "Self.Page", metadata: { name: "home", ...app } },
      { kind: "App.Page", metadata: { name: "about", ...app } },
      { kind: "Telo.Definition", metadata: { name: "Page", ...app }, extends: "Lib.Base" },
      { kind: "Telo.Import", metadata: { name: "Lib", ...app }, source: "./lib" },
    ]);
    expect(order.indexOf("Lib")).toBeLessThan(order.indexOf("echo"));
    expect(order.indexOf("Lib")).toBeLessThan(order.indexOf("Page"));
    expect(order.indexOf("Page")).toBeLessThan(order.indexOf("home"));
    expect(order.indexOf("Page")).toBeLessThan(order.indexOf("about"));
  });

  it("lets a dependency win over a kind's declaration instead of reporting a cycle", () => {
    // The import is handed an instance of a kind it exports itself: the instance
    // must exist before the import, and it is spelled through the import's alias.
    const { order, cycle } = buildDependencyGraph(
      [
        {
          kind: "Telo.Import",
          metadata: { name: "Lib" },
          source: "./lib",
          resources: { connection: { kind: "Lib.Connection", name: "db" } },
        },
        { kind: "Lib.Connection", metadata: { name: "db" } },
      ] as unknown as ResourceManifest[],
      registryOf(),
      appAliases(),
    );
    expect(cycle).toBeUndefined();
    expect(order!.map((n) => n.name)).toEqual(["db", "Lib"]);
  });
});
