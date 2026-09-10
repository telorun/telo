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

  it("does not flag a CEL field an extends child inherits from its parent", () => {
    // Without `base:`, a child is authored against merge(parent, own), and the
    // kernel stamps that merged schema at definition registration — so it
    // expands the inherited field. Reading the child's OWN schema here reported
    // the expression as never evaluated, which is the analyzer and the runtime
    // disagreeing about what the manifest means.
    const parent = makeKind("Test.Base", {
      type: "array",
      "x-telo-context": { type: "object", properties: {} },
    });
    const child = {
      kind: "Telo.Definition",
      metadata: { name: "Child", module: "Test" },
      capability: "Telo.Service",
      extends: "Test.Base",
      schema: { type: "object", properties: { other: { type: "integer" } } },
    } as unknown as ResourceManifest;
    const res = instance("Test.Child");
    const diagnostics = new StaticAnalyzer()
      .analyze(withSyntheticPositions([parent, child, res]))
      .filter((d) => d.code === "CEL_IN_NON_EVAL_FIELD");
    expect(diagnostics).toEqual([]);
  });

  it("types an x-telo-context region an extends child inherits", () => {
    // The region and the check live on different kinds: the parent declares the
    // scope, the child declares only its own field. Reading the child's OWN
    // schema found no region, so every expression on every descendant went
    // unchecked — which for a typing rule is the check silently not existing.
    const parent = makeKind("Test.Base", {
      type: "object",
      "x-telo-context": {
        type: "object",
        properties: { row: { type: "object", properties: { label: { type: "string" } } } },
      },
    });
    const child = {
      kind: "Telo.Definition",
      metadata: { name: "Child", module: "Test" },
      capability: "Telo.Invocable",
      extends: "Test.Base",
      schema: { type: "object", properties: {} },
    } as unknown as ResourceManifest;
    const res: ResourceManifest = {
      kind: "Test.Child",
      metadata: { name: "r" },
      field: { row: makeTaggedSentinel("cel", "row.labell") },
    } as unknown as ResourceManifest;
    const codes = new StaticAnalyzer()
      .analyze(withSyntheticPositions([parent, child, res]))
      .filter((d) => d.code === "CEL_UNKNOWN_FIELD");
    expect(codes).toHaveLength(1);
    expect(codes[0].message).toContain("label");
  });

  describe("on an inheritance kind, whose capability is inherited", () => {
    // The gate read the DECLARED capability, and an `extends` child writes
    // none — so the rule was off for every inheritance kind, and the
    // expressions in its fields were never typed either.
    const parent = makeKind("Test.Base", { type: "string" }, "Telo.Service", {
      properties: { field: { type: "string" }, label: { type: "string" } },
    });
    const mergeChild = {
      kind: "Telo.Definition",
      metadata: { name: "Merge", module: "Test" },
      extends: "Test.Base",
      schema: { type: "object", properties: { extra: { type: "string" } } },
    } as unknown as ResourceManifest;
    const baseChild = {
      kind: "Telo.Definition",
      metadata: { name: "Mapped", module: "Test" },
      extends: "Test.Base",
      schema: { type: "object", properties: { label: { type: "string" } } },
      base: { field: makeTaggedSentinel("cel", "self.label") },
    } as unknown as ResourceManifest;
    const analyze = (res: ResourceManifest, code: string) =>
      new StaticAnalyzer()
        .analyze(withSyntheticPositions([parent, mergeChild, baseChild, res]))
        .filter((d) => d.code === code);

    it("flags a !cel in a merge-form child's un-annotated field, as on the parent", () => {
      const res = { kind: "Test.Merge", metadata: { name: "r" }, extra: makeTaggedSentinel("cel", "variables.x") } as unknown as ResourceManifest;
      expect(analyze(res, "CEL_IN_NON_EVAL_FIELD")).toHaveLength(1);
    });

    it("reads a base-form child's own fields as compile-eval, and types them", () => {
      // `base:` reads `self` once at create(), so every own field IS evaluated
      // there — the rule says so rather than leaving it to the mapping walk.
      const ok = { kind: "Test.Mapped", metadata: { name: "r" }, label: makeTaggedSentinel("cel", "variables.x") } as unknown as ResourceManifest;
      expect(analyze(ok, "CEL_IN_NON_EVAL_FIELD")).toEqual([]);
      // A field the rule reads as evaluated is a field the engine checks: the
      // non-eval branch used to return before analysis, so a broken expression
      // here reached boot.
      const broken = { kind: "Test.Mapped", metadata: { name: "r" }, label: makeTaggedSentinel("cel", "variables.x +") } as unknown as ResourceManifest;
      expect(analyze(broken, "CEL_IN_NON_EVAL_FIELD")).toEqual([]);
      expect(analyze(broken, "CEL_SYNTAX_ERROR")).toHaveLength(1);
    });

    it("reports observed-state reads in a base-form child's field as startup reads", () => {
      const producerKind = {
        kind: "Telo.Definition",
        metadata: { name: "Producer", module: "Test" },
        capability: "Telo.Service",
        schema: { type: "object" },
        status: { type: "object", properties: { ready: { type: "boolean" } } },
      } as unknown as ResourceManifest;
      const producer = { kind: "Test.Producer", metadata: { name: "other" } } as unknown as ResourceManifest;
      const app = {
        kind: "Telo.Application",
        metadata: { name: "App" },
        targets: [{ kind: "Test.Producer", name: "other" }],
      } as unknown as ResourceManifest;
      const res = { kind: "Test.Mapped", metadata: { name: "r" }, label: makeTaggedSentinel("cel", "resources.other.status.ready") } as unknown as ResourceManifest;
      const startup = new StaticAnalyzer()
        .analyze(withSyntheticPositions([app, parent, mergeChild, baseChild, producerKind, producer, res]))
        .filter((d) => d.code === "OBSERVED_STATE_IN_STARTUP_FIELD");
      expect(startup).toHaveLength(1);
    });
  });
});
