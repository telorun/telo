import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";

/**
 * The scope query — the way into the CEL scope rule from outside the analysis
 * pass. What it must get right is that it answers for an ADDRESS rather than
 * for a walked expression, since an IDE's cursor is frequently sitting in an
 * expression the last analysis never saw.
 */

const SEQUENCE_DEF: ResourceDefinition = {
  kind: "Telo.Definition",
  metadata: { name: "Sequence", module: "test-run" },
  capability: "Telo.Runnable",
  schema: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        "x-telo-step-context": { invoke: "invoke", outputType: "outputType" },
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            invoke: { "x-telo-ref": "telo#Invocable" },
            then: { type: "array", "x-telo-topology-role": "branch" },
          },
        },
      },
    },
  },
} as unknown as ResourceDefinition;

const APP: ResourceManifest = {
  kind: "Telo.Application",
  metadata: { name: "TestApp", module: "test-run" },
  variables: { greeting: { env: "GREETING", type: "string" } },
} as unknown as ResourceManifest;

const SEQUENCE: ResourceManifest = {
  kind: "Run.Sequence",
  metadata: { name: "flow", module: "test-run" },
  steps: [
    { name: "first", invoke: { kind: "Telo.Invocable", name: "x" } },
    { name: "wrapper", then: [{ name: "nested", invoke: { kind: "Telo.Invocable", name: "y" } }] },
  ],
} as unknown as ResourceManifest;

function registry(): AnalysisRegistry {
  const r = new AnalysisRegistry();
  r.registerModuleIdentity("std", "test-run");
  r.registerImport("Run", "test-run", ["Sequence"]);
  r.registerDefinition(SEQUENCE_DEF);
  return r;
}

describe("CelScopeQuery", () => {
  const manifests = [APP, SEQUENCE];

  it("types a site the analysis never walked — the live-typing case", () => {
    const query = registry().analysisOf(manifests).celScope;
    const resource = query.resourceFor("Run.Sequence", "flow")!;
    // A path carrying no expression at all: this is what a cursor in a
    // half-written `!cel` addresses.
    const scope = query.scopeAt(resource, "steps[0].inputs.q");
    const names = scope.env.getDefinitions().variables.map((v) => v.name);
    expect(names).toContain("variables");
  });

  it("puts each step's result in scope", () => {
    const query = registry().analysisOf(manifests).celScope;
    const resource = query.resourceFor("Run.Sequence", "flow")!;
    const scope = query.scopeAt(resource, "steps[1].inputs.q");
    const steps = scope.contextSchema?.properties?.steps?.properties;
    expect(Object.keys(steps ?? {}).sort()).toEqual(["first", "nested"]);
  });

  it("locates a step's declaration, including one nested in a branch", () => {
    const query = registry().analysisOf(manifests).celScope;
    const resource = query.resourceFor("Run.Sequence", "flow")!;
    expect(query.stepDeclarationPath(resource, "first")).toBe("steps[0]");
    expect(query.stepDeclarationPath(resource, "nested")).toBe("steps[1].then[0]");
    expect(query.stepDeclarationPath(resource, "absent")).toBeUndefined();
  });

  it("reports no resource for a document the analyzed set does not hold", () => {
    const query = registry().analysisOf(manifests).celScope;
    expect(query.resourceFor("Run.Sequence", "brand-new")).toBeUndefined();
  });
});
