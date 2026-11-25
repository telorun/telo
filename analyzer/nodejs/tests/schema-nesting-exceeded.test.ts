import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { DefinitionRegistry } from "../src/definition-registry.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/** Every `SCHEMA_NESTING_EXCEEDED` the analysis of `manifests` reports, with its path. */
function nestingFindings(manifests: ResourceManifest[]): { path: string | undefined; message: string }[] {
  return new StaticAnalyzer()
    .analyze(withSyntheticPositions(manifests))
    .filter((d) => d.code === "SCHEMA_NESTING_EXCEEDED")
    .map((d) => ({ path: (d.data as { path?: string } | undefined)?.path, message: d.message }));
}

describe("a validation that cannot finish", () => {
  it("is reported at the base: field whose parent schema refers to itself without descending", () => {
    const parent = {
      kind: "Telo.Definition",
      metadata: { name: "Parent", module: "Test" },
      capability: "Telo.Invocable",
      schema: { type: "object", properties: { tree: { type: "object", $ref: "#" } } },
    };
    const child = {
      kind: "Telo.Definition",
      metadata: { name: "Child", module: "Test" },
      extends: "Test.Parent",
      schema: { type: "object" },
      base: { tree: { leaf: 1 } },
    };
    const module = { kind: "Telo.Application", metadata: { name: "Test" } };
    expect(nestingFindings([module, parent, child] as unknown as ResourceManifest[])).toEqual([
      {
        path: "base.tree",
        message:
          "Telo.Definition/Child: 'base.tree' cannot be validated — validating it nests past the depth a " +
          "validation may reach. Either its schema refers to itself without descending into the value, or the " +
          "value is nested deeper than a validation can follow: make each self-reference descend into the value " +
          "at every step, or nest the value less deeply.",
      },
    ]);
  });

  it("is what a value nested past the depth a built-in fragment can be followed answers", () => {
    let step: Record<string, unknown> = { name: "leaf", value: 1 };
    for (let depth = 0; depth < 5000; depth++) step = { name: `s${depth}`, if: true, then: [step] };
    const steps = { type: "array", items: { $ref: "telo://manifest#/$defs/Step" } };
    expect(new DefinitionRegistry().validateResourceConfig([step], steps)).toEqual({ finished: false });
  });
});
