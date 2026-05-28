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
