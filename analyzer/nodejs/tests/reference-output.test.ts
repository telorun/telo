import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { validateRefSlotDeclarations } from "../src/validate-ref-slots.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/** A kind whose reference slot requires its target to return `{ output: <stream> }`. */
const joinerDef = {
  kind: "Telo.Definition",
  metadata: { name: "Joiner", module: "srv" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      source: {
        "x-telo-ref": {
          kind: "Telo.Executable",
          use: "trigger.consumer",
          outputType: {
            type: "object",
            required: ["output"],
            properties: { output: { "x-telo-type": "Telo.Stream" } },
          },
        },
      },
    },
  },
};

/** An invocable kind whose output contract each test states. */
const producerDef = (outputSchema: Record<string, unknown> | undefined) => ({
  kind: "Telo.Definition",
  metadata: { name: "Producer", module: "srv" },
  capability: "Telo.Invocable",
  ...(outputSchema ? { outputType: { kind: "Telo.JsonSchema", schema: outputSchema } } : {}),
  schema: { type: "object", additionalProperties: true },
});

function mismatches(outputSchema: Record<string, unknown> | undefined) {
  const manifests = [
    { kind: "Telo.Application", metadata: { name: "app", source: "telo.yaml" } },
    joinerDef,
    producerDef(outputSchema),
    { kind: "srv.Producer", metadata: { name: "producer", source: "telo.yaml" } },
    {
      kind: "srv.Joiner",
      metadata: { name: "joiner", source: "telo.yaml" },
      source: makeTaggedSentinel("ref", "producer"),
    },
  ] as unknown as ResourceManifest[];
  return new StaticAnalyzer()
    .analyze(withSyntheticPositions(manifests))
    .filter((d) => d.code === "REFERENCE_OUTPUT_MISMATCH");
}

describe("x-telo-ref outputType", () => {
  it("accepts a target whose output contract has the required shape", () => {
    expect(
      mismatches({
        type: "object",
        additionalProperties: false,
        required: ["output"],
        properties: { output: { "x-telo-type": "Telo.Stream" } },
      }),
    ).toEqual([]);
  });

  it("refuses a closed contract missing the required field, at the slot", () => {
    const diags = mismatches({
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: { items: { type: "array" } },
    });
    expect(diags).toHaveLength(1);
    expect((diags[0].data as { path?: string }).path).toBe("source");
    expect(diags[0].message).toContain("srv.Producer 'producer'");
    expect(diags[0].message).toContain("/output: required by this slot but missing from the target's output");
  });

  it("refuses an output field that is not a stream", () => {
    const diags = mismatches({
      type: "object",
      required: ["output"],
      properties: { output: { type: "string" } },
    });
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain(
      "/output: value type mismatch — this slot expects 'Telo.Stream', the target's output is 'string'",
    );
  });

  it("gives no verdict for a target declaring no output contract", () => {
    expect(mismatches(undefined)).toEqual([]);
  });

  it("refuses an outputType that is not a schema object", () => {
    const issues = validateRefSlotDeclarations({
      kind: "Telo.Definition",
      metadata: { name: "Thing", module: "test" },
      capability: "Telo.Invocable",
      schema: {
        type: "object",
        properties: { slot: { "x-telo-ref": { kind: "Telo.Invocable", use: "call", outputType: "stream" } } },
      },
    } as unknown as ResourceManifest);
    expect(issues.map((i) => i.code)).toEqual(["X_TELO_REF_INVALID_OUTPUT_TYPE"]);
  });
});
