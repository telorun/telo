import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/** A `Telo.Definition` whose `field` carries the given schema fragment. Lets each
 *  case decide whether the field is a CEL slot (`x-telo-context` / `x-telo-eval`)
 *  or a plain literal. */
function makeKind(
  kind: string,
  fieldSchema: Record<string, unknown>,
  capability = "Telo.Service",
  rootSchema: Record<string, unknown> = {},
): ResourceManifest {
  const [moduleName, typeName] = kind.split(".") as [string, string];
  return {
    kind: "Telo.Definition",
    metadata: { name: typeName, module: moduleName },
    capability,
    schema: {
      type: "object",
      properties: { field: fieldSchema },
      ...rootSchema,
    },
  } as unknown as ResourceManifest;
}

function instance(kind: string, expr = "variables.x"): ResourceManifest {
  return {
    kind,
    metadata: { name: "r" },
    field: makeTaggedSentinel("cel", expr),
  } as unknown as ResourceManifest;
}

function nonEvalDiagnostics(def: ResourceManifest, res: ResourceManifest) {
  return new StaticAnalyzer()
    .analyze(withSyntheticPositions([def, res]))
    .filter((d) => d.code === "CEL_IN_NON_EVAL_FIELD");
}

describe("CEL in a non-eval field", () => {
  it("flags a !cel in a field with no x-telo-eval / x-telo-context", () => {
    const def = makeKind("Test.Thing", { type: "integer" });
    const diagnostics = nonEvalDiagnostics(def, instance("Test.Thing"));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("is never evaluated");
    expect((diagnostics[0].data as { path?: string }).path).toBe("field");
  });

  it("does not flag a field annotated x-telo-context", () => {
    const def = makeKind("Test.Thing", {
      type: "integer",
      "x-telo-context": { type: "object", properties: {} },
    });
    expect(nonEvalDiagnostics(def, instance("Test.Thing"))).toEqual([]);
  });

  it("does not flag a field annotated x-telo-eval", () => {
    const def = makeKind("Test.Thing", { type: "integer", "x-telo-eval": "compile" });
    expect(nonEvalDiagnostics(def, instance("Test.Thing"))).toEqual([]);
  });

  it("does not flag any field of a Telo.Provider (all fields implicitly eval)", () => {
    // The Provider abstract carries a root `x-telo-eval: compile`; the analyzer
    // resolves it via the capability so provider config fields stay live.
    const def = makeKind("Test.Secret", { type: "integer" }, "Telo.Provider");
    expect(nonEvalDiagnostics(def, instance("Test.Secret"))).toEqual([]);
  });

  it("does not flag a descendant of an x-telo-context container field", () => {
    const def = makeKind("Test.Thing", {
      type: "object",
      "x-telo-context": { type: "object", properties: {} },
      properties: { inner: { type: "integer" } },
    });
    const res: ResourceManifest = {
      kind: "Test.Thing",
      metadata: { name: "r" },
      field: { inner: makeTaggedSentinel("cel", "variables.x") },
    } as unknown as ResourceManifest;
    expect(nonEvalDiagnostics(def, res)).toEqual([]);
  });
});
