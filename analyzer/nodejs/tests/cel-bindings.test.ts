import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { resolveBindingOrder } from "../src/cel-bindings.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/** Minimal Run.Value-shaped definition: a `bindings:` map whose names are in
 *  scope both inside itself and inside `value`, wired with the generic
 *  `x-telo-bindings-from` annotation. Mirrors the real `std/run` schema. */
const valueDef = {
  kind: "Telo.Definition",
  metadata: { name: "Value", module: "run" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    properties: {
      inputType: { "x-telo-ref": "Telo.Type" },
      bindings: {
        type: "object",
        additionalProperties: true,
        "x-telo-context": {
          type: "object",
          "x-telo-bindings-from": "bindings",
          properties: { inputs: { type: "object", "x-telo-context-from": "inputType" } },
        },
      },
      value: {
        "x-telo-context": {
          type: "object",
          "x-telo-bindings-from": "bindings",
          properties: { inputs: { type: "object", "x-telo-context-from": "inputType" } },
        },
      },
    },
  },
} as unknown as ResourceManifest;

function runValue(
  bindings: Record<string, string>,
  value: Record<string, string>,
): ResourceManifest {
  const cel = (source: string) => `\${{ ${source} }}`;
  return {
    kind: "run.Value",
    metadata: { name: "Priced", module: "test" },
    inputType: {
      kind: "Telo.JsonSchema",
      schema: {
        type: "object",
        properties: { qty: { type: "number" }, unit: { type: "number" } },
      },
    },
    bindings: Object.fromEntries(Object.entries(bindings).map(([k, v]) => [k, cel(v)])),
    value: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cel(v)])),
  } as unknown as ResourceManifest;
}

function analyze(manifest: ResourceManifest) {
  return new StaticAnalyzer().analyze(withSyntheticPositions([valueDef, manifest]));
}

describe("named CEL bindings", () => {
  it("puts binding names in scope for each other and for the value, in any declaration order", () => {
    const diagnostics = analyze(
      runValue(
        { net: "gross - discount", gross: "inputs.qty * inputs.unit", discount: "gross * 0.1" },
        { net: "net", gross: "gross" },
      ),
    );
    expect(diagnostics.filter((d) => d.code === "CEL_UNKNOWN_FIELD")).toEqual([]);
  });

  it("reports a reference to a name that is neither a binding nor in scope", () => {
    const diagnostics = analyze(runValue({ gross: "inputs.qty" }, { net: "grosss" }));
    expect(diagnostics.map((d) => d.code)).toContain("CEL_UNKNOWN_FIELD");
  });

  it("types a binding from the chain it reads, so an unknown field under it is caught", () => {
    const diagnostics = analyze(runValue({ line: "inputs.qty" }, { bad: "line.nope" }));
    expect(diagnostics.filter((d) => d.code === "CEL_UNKNOWN_FIELD")).toEqual([]);

    const typed = analyze(
      runValue({ order: "inputs" }, { bad: "order.nope" }),
    );
    expect(typed.filter((d) => d.code === "CEL_UNKNOWN_FIELD").map((d) => d.message)).toHaveLength(
      1,
    );
  });

  it("rejects a cycle, naming the path that closes it", () => {
    const diagnostics = analyze(
      runValue({ a: "b + 1.0", b: "c + 1.0", c: "a + 1.0" }, { out: "a" }),
    );
    const cycle = diagnostics.filter((d) => d.code === "BINDING_CYCLE");
    expect(cycle).toHaveLength(1);
    expect(cycle[0]!.message).toMatch(/a → b → c → a/);
  });

  it("does not invent a cycle from field names shared with sibling bindings", () => {
    // `inputs.total` depends on `inputs`, not on the binding named `total`. A
    // token scan would read both as edges and reject this correct manifest.
    const diagnostics = analyze(
      runValue({ qty: "inputs.total", total: "inputs.qty" }, { out: "qty + total" }),
    );
    expect(diagnostics.filter((d) => d.code === "BINDING_CYCLE")).toEqual([]);
  });

  it("rejects a binding named after a CEL keyword, which no expression could read", () => {
    const diagnostics = analyze(runValue({ true: "inputs.qty" }, { out: "1.0" }));
    const reserved = diagnostics.filter((d) => d.code === "BINDING_NAME_RESERVED");
    expect(reserved).toHaveLength(1);
    expect(reserved[0]!.message).toMatch(/CEL keyword/);
  });

  it("rejects a binding that shadows a kernel global or a declared scope variable", () => {
    const globals = analyze(runValue({ resources: "inputs.qty" }, { out: "1.0" }));
    expect(globals.filter((d) => d.code === "BINDING_NAME_RESERVED")).toHaveLength(1);

    const scoped = analyze(runValue({ inputs: "1.0" }, { out: "1.0" }));
    expect(scoped.filter((d) => d.code === "BINDING_NAME_RESERVED")).toHaveLength(1);
  });
});

describe("resolveBindingOrder", () => {
  it("orders each binding after the ones it reads", () => {
    const compiled = (source: string, refs: string[]) => ({ __compiled: true, source, refs });
    const { order, cycles } = resolveBindingOrder({
      net: compiled("gross - discount", ["gross", "discount"]),
      gross: compiled("inputs.qty", ["inputs"]),
      discount: compiled("gross * 0.1", ["gross"]),
    });
    expect(cycles).toEqual([]);
    expect(order.indexOf("gross")).toBeLessThan(order.indexOf("discount"));
    expect(order.indexOf("discount")).toBeLessThan(order.indexOf("net"));
  });
});
