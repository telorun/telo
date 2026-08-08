import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { buildDependencyGraph, formatCycle } from "../src/dependency-graph.js";
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
