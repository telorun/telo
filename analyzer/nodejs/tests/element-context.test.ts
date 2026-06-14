import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/** Minimal Run.Iteration-shaped definition: a `collection` expression plus a
 *  `steps` body whose CEL context binds `item` via `x-telo-context-element-from`,
 *  pointing at the sibling `collection`. Mirrors the real `std/run` schema. */
const iterationDef = {
  kind: "Telo.Definition",
  metadata: { name: "Iteration", module: "run" },
  capability: "Telo.Runnable",
  schema: {
    type: "object",
    $defs: {
      bodyStep: {
        type: "object",
        properties: {
          name: { type: "string" },
          invoke: { "x-telo-topology-role": "invoke", type: "object", additionalProperties: true },
          inputs: { "x-telo-topology-role": "inputs", type: "object", additionalProperties: true },
        },
      },
    },
    properties: {
      inputs: { type: "object", additionalProperties: true },
      collection: {
        type: "array",
        "x-telo-context": { type: "object", properties: { inputs: {} } },
      },
      steps: {
        "x-telo-topology-role": "steps",
        "x-telo-step-context": { invoke: "invoke", outputType: "outputType" },
        "x-telo-context": {
          type: "object",
          properties: {
            inputs: {},
            item: { "x-telo-context-element-from": "collection" },
            index: { type: "integer" },
            items: { type: "array" },
          },
        },
        type: "array",
        items: { $ref: "#/$defs/bodyStep" },
      },
    },
  },
} as unknown as ResourceManifest;

function iteration(collection: string, itemAccess: string): ResourceManifest {
  return {
    kind: "run.Iteration",
    metadata: { name: "It", module: "test" },
    inputs: {
      records: {
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" }, age: { type: "integer" } },
        },
      },
    },
    collection: `\${{ ${collection} }}`,
    steps: [{ name: "shape", invoke: { kind: "Some.Sink" }, inputs: { who: `\${{ ${itemAccess} }}` } }],
  } as unknown as ResourceManifest;
}

describe("x-telo-context-element-from (item typed from collection)", () => {
  it("infers item's element type from a typed inputs.* collection (no false positive)", () => {
    const diagnostics = new StaticAnalyzer().analyze(
      withSyntheticPositions([iterationDef, iteration("inputs.records", "item.name")]),
    );
    expect(diagnostics.filter((d) => d.code === "CEL_UNKNOWN_FIELD")).toEqual([]);
  });

  it("flags an unknown field on the inferred item type", () => {
    const diagnostics = new StaticAnalyzer().analyze(
      withSyntheticPositions([iterationDef, iteration("inputs.records", "item.bogus")]),
    );
    const unknown = diagnostics.filter((d) => d.code === "CEL_UNKNOWN_FIELD");
    expect(unknown.length).toBeGreaterThan(0);
    expect(unknown[0].message).toContain("'item.bogus' is not defined");
    expect(unknown[0].message).toContain("name");
    expect(unknown[0].message).toContain("age");
  });

  it("falls back to dyn for a list-literal collection (any access allowed)", () => {
    const diagnostics = new StaticAnalyzer().analyze(
      withSyntheticPositions([iterationDef, iteration("[1, 2, 3]", "item.anything")]),
    );
    expect(diagnostics.filter((d) => d.code === "CEL_UNKNOWN_FIELD")).toEqual([]);
  });

  it("walks a nested inputs chain to the element type", () => {
    const m = {
      kind: "run.Iteration",
      metadata: { name: "It", module: "test" },
      inputs: {
        payload: {
          type: "object",
          properties: {
            records: { type: "array", items: { type: "object", properties: { id: { type: "string" } } } },
          },
        },
      },
      collection: "${{ inputs.payload.records }}",
      steps: [
        { name: "ok", invoke: { kind: "Some.Sink" }, inputs: { a: "${{ item.id }}" } },
        { name: "bad", invoke: { kind: "Some.Sink" }, inputs: { b: "${{ item.nope }}" } },
      ],
    } as unknown as ResourceManifest;

    const unknown = new StaticAnalyzer()
      .analyze(withSyntheticPositions([iterationDef, m]))
      .filter((d) => d.code === "CEL_UNKNOWN_FIELD");
    expect(unknown.length).toBe(1);
    expect(unknown[0].message).toContain("item.nope");
  });

  it("rejects a statically non-array collection (SCHEMA_VIOLATION)", () => {
    const m = {
      kind: "run.Iteration",
      metadata: { name: "It", module: "test" },
      inputs: {},
      collection: "${{ 42 }}",
      steps: [{ name: "s", invoke: { kind: "Some.Sink" } }],
    } as unknown as ResourceManifest;

    const diagnostics = new StaticAnalyzer().analyze(withSyntheticPositions([iterationDef, m]));
    expect(diagnostics.some((d) => d.code === "SCHEMA_VIOLATION")).toBe(true);
  });
});
