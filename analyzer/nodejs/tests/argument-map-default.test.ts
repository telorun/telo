import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/**
 * An omitted argument map is judged as the `default:` its property declares, at
 * the reference; a kind letting one be omitted without a literal object default
 * is refused at the kind.
 */

const ref = (name: string) => makeTaggedSentinel("ref", name);

const app = { kind: "Telo.Application", metadata: { name: "App" } } as unknown as ResourceManifest;

/** A consumer kind of another module, so its own schema is not judged here. */
const caller = (inputs: Record<string, unknown>): ResourceDefinition =>
  ({
    kind: "Telo.Definition",
    metadata: { name: "Caller", module: "lib" },
    capability: "Telo.Service",
    schema: {
      type: "object",
      properties: {
        handler: { "x-telo-ref": { kind: "Telo.Executable", use: "call", inputs: "/inputs" } },
        inputs: { type: "object", additionalProperties: true, ...inputs },
      },
    },
  }) as unknown as ResourceDefinition;

const needsKey = {
  kind: "Telo.Sequence",
  metadata: { name: "target", module: "App" },
  inputType: {
    kind: "Telo.JsonSchema",
    schema: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
  },
  steps: [{ name: "done", value: true }],
} as unknown as ResourceManifest;

function analyzeWith(definition: ResourceDefinition | undefined, ...manifests: ResourceManifest[]) {
  const registry = new AnalysisRegistry();
  if (definition) {
    registry.registerModuleIdentity("std", "lib");
    registry.registerImport("Lib", "lib", ["Caller"]);
    registry.registerDefinition(definition);
  }
  return new StaticAnalyzer().analyze(withSyntheticPositions([app, needsKey, ...manifests]), undefined, registry);
}

const found = (diagnostics: { code?: string | number; message: string; data?: unknown }[], code: string) =>
  diagnostics
    .filter((d) => d.code === code)
    .map((d) => ({ path: (d.data as { path?: string }).path, message: d.message }));

const consumer = (extra: Record<string, unknown> = {}) =>
  ({ kind: "Lib.Caller", metadata: { name: "caller", module: "App" }, handler: ref("target"), ...extra }) as unknown as ResourceManifest;

describe("an omitted argument map at a reference slot", () => {
  it("is judged as the default its property declares, at the slot", () => {
    const [finding, ...rest] = found(analyzeWith(caller({ default: {} }), consumer()), "CONTRACT_INPUTS_MISMATCH");
    expect(rest).toEqual([]);
    expect(finding!.path).toBe("handler");
    expect(finding!.message).toContain("the default {}");
    expect(finding!.message).toContain("missing required property 'key'");
    expect(finding!.message).toContain("Write 'inputs:' at 'inputs'");
  });

  it("is unjudged when a dependency's property declares no default", () => {
    expect(found(analyzeWith(caller({}), consumer()), "CONTRACT_INPUTS_MISMATCH")).toEqual([]);
  });
});

describe("an omitted argument map at a step", () => {
  it("is judged as the built-in step's default, at its invoke field", () => {
    const main = {
      kind: "Telo.Sequence",
      metadata: { name: "main", module: "App" },
      steps: [{ name: "call", invoke: ref("target") }],
    } as unknown as ResourceManifest;
    const findings = found(analyzeWith(undefined, main), "CONTRACT_INPUTS_MISMATCH");
    expect(findings.map((f) => f.path)).toEqual(["steps[0].invoke"]);
  });
});

describe("ARGUMENT_MAP_DEFAULT_INVALID", () => {
  const own = (properties: Record<string, unknown>, required: string[] = []) =>
    ({
      kind: "Telo.Definition",
      metadata: { name: "Own", module: "App" },
      capability: "Telo.Service",
      schema: { type: "object", required, properties },
    }) as unknown as ResourceManifest;
  const slot = { "x-telo-ref": { kind: "Telo.Executable", use: "call", inputs: "/inputs" } };
  const paths = (definition: ResourceManifest) =>
    found(analyzeWith(undefined, definition), "ARGUMENT_MAP_DEFAULT_INVALID").map((f) => f.path);

  it("refuses an optional paired property with no default", () => {
    expect(paths(own({ handler: slot, inputs: { type: "object" } }))).toEqual(["schema.properties.inputs"]);
  });

  it("refuses a default that is not a literal object", () => {
    const tagged = own({ handler: slot, inputs: { type: "object", default: makeTaggedSentinel("cel", "{}") } });
    const list = own({ handler: slot, inputs: { type: "object", default: [] } });
    expect([...paths(tagged), ...paths(list)]).toEqual(["schema.properties.inputs", "schema.properties.inputs"]);
  });

  it("refuses a pointer naming no declared property", () => {
    expect(paths(own({ handler: slot }))).toEqual(["schema.properties.handler"]);
  });

  it("accepts a literal object default, and a required property with none", () => {
    expect(paths(own({ handler: slot, inputs: { type: "object", default: { a: 1 } } }))).toEqual([]);
    expect(paths(own({ handler: slot, inputs: { type: "object" } }, ["inputs"]))).toEqual([]);
  });

  it("refuses a kind's own step item whose role-marked argument map has no default", () => {
    const steps = own({
      steps: {
        type: "array",
        "x-telo-step-context": { invoke: "invoke" },
        items: {
          type: "object",
          properties: {
            invoke: { "x-telo-topology-role": "invoke" },
            inputs: { "x-telo-topology-role": "inputs", type: "object" },
          },
        },
      },
    });
    expect(paths(steps)).toEqual(["schema.properties.steps.items.properties.inputs"]);
  });
});

describe("the kernel's decoding of an omitted argument map", () => {
  it("yields no slot, so nothing is written into the manifest", () => {
    const registry = new AnalysisRegistry();
    registry.registerModuleIdentity("std", "lib");
    registry.registerImport("Lib", "lib", ["Caller", "Target"]);
    registry.registerDefinition(caller({ default: {} }));
    registry.registerDefinition({
      kind: "Telo.Definition",
      metadata: { name: "Target", module: "lib" },
      capability: "Telo.Invocable",
      inputType: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
      schema: { type: "object" },
    } as unknown as ResourceDefinition);
    const resource = {
      kind: "Lib.Caller",
      metadata: { name: "caller", module: "App" },
      handler: { kind: "Lib.Target", name: "target" },
    } as unknown as ResourceManifest;
    const slots = registry.derivedSlotsOf(resource, {
      rootModules: new Set(["App"]),
      types: { names: new Map(), all: [] } as never,
      resolveTarget: () => ({ kind: "Lib.Target", metadata: { name: "target" } }),
    });
    expect(slots.map((s) => s.path)).toEqual([]);
    expect("inputs" in resource).toBe(false);
  });
});
