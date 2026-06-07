import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

function analyze(manifests: unknown[]) {
  return new StaticAnalyzer().analyze(withSyntheticPositions(manifests as ResourceManifest[]));
}

describe("fail-loud validation", () => {
  it("reports a definition schema AJV cannot compile instead of silently skipping", () => {
    // An unresolvable local `$ref` makes AJV throw on compile; without the
    // compile check, `validateAgainstSchema` swallows it and every resource of
    // this kind passes schema validation silently.
    const brokenDef = {
      kind: "Telo.Definition",
      metadata: { name: "Broken", module: "test" },
      capability: "Telo.Invocable",
      schema: {
        type: "object",
        properties: { x: { $ref: "#/$defs/DoesNotExist" } },
      },
    };

    const compileErrors = analyze([brokenDef]).filter((d) => d.code === "SCHEMA_COMPILE_ERROR");
    expect(compileErrors.length).toBe(1);
    expect(compileErrors[0].message).toContain("Telo.Definition/Broken");
    expect((compileErrors[0].data as { path?: string }).path).toBe("schema");
  });

  it("reports a kind's broken schema once even when instances exist, without crashing", () => {
    // A resource of the broken kind reaches per-resource validation. The compile
    // failure must surface once (on the definition, via the pre-check) — not crash
    // analysis and not re-report per instance — proving the skip in
    // `validateAgainstSchema` is a deliberate dedup, not a silent swallow.
    const brokenDef = {
      kind: "Telo.Definition",
      metadata: { name: "Broken", module: "test" },
      capability: "Telo.Invocable",
      schema: { type: "object", properties: { x: { $ref: "#/$defs/DoesNotExist" } } },
    };
    const a = { kind: "test.Broken", metadata: { name: "a" }, x: 1 };
    const b = { kind: "test.Broken", metadata: { name: "b" }, x: 2 };

    const diagnostics = analyze([brokenDef, a, b]);
    expect(diagnostics.filter((d) => d.code === "SCHEMA_COMPILE_ERROR").length).toBe(1);
    expect(diagnostics.filter((d) => d.code === "SCHEMA_VIOLATION")).toEqual([]);
  });

  it("does not report SCHEMA_COMPILE_ERROR for a valid definition schema", () => {
    const goodDef = {
      kind: "Telo.Definition",
      metadata: { name: "Good", module: "test" },
      capability: "Telo.Invocable",
      schema: { type: "object", properties: { label: { type: "string" } }, additionalProperties: false },
    };

    expect(analyze([goodDef]).filter((d) => d.code === "SCHEMA_COMPILE_ERROR")).toEqual([]);
  });

  it("reports an expression tagged with an unregistered engine instead of skipping it", () => {
    const def = {
      kind: "Telo.Definition",
      metadata: { name: "Thing", module: "test" },
      capability: "Telo.Invocable",
      schema: { type: "object", properties: { label: { type: "string" } }, additionalProperties: false },
    };
    const res = {
      kind: "test.Thing",
      metadata: { name: "t" },
      label: makeTaggedSentinel("bogus", "1 + 1"),
    };

    const unknownEngine = analyze([def, res]).filter((d) => d.code === "UNKNOWN_ENGINE");
    expect(unknownEngine.length).toBe(1);
    expect(unknownEngine[0].message).toContain("!bogus");
    expect((unknownEngine[0].data as { path?: string }).path).toBe("label");
  });

  it("does not report UNKNOWN_ENGINE for the built-in cel/literal engines", () => {
    const def = {
      kind: "Telo.Definition",
      metadata: { name: "Thing", module: "test" },
      capability: "Telo.Invocable",
      schema: { type: "object", properties: { label: { type: "string" } }, additionalProperties: false },
    };
    const res = {
      kind: "test.Thing",
      metadata: { name: "t" },
      label: makeTaggedSentinel("literal", "hello"),
    };

    expect(analyze([def, res]).filter((d) => d.code === "UNKNOWN_ENGINE")).toEqual([]);
  });
});
