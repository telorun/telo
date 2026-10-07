import type { ResourceContext } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { isScalar, modelSchema } from "../src/model-schema.js";

const registry: Record<string, object> = { "telo:App/Todo": { type: "object", properties: { text: { type: "string" } } } };
const ctx = { lookupSchema: (name: string) => registry[name] } as unknown as ResourceContext;

describe("the schema a model slot names", () => {
  it("is read from each form the slot can hold", () => {
    const inline = { type: "object", properties: { id: { type: "integer" } } };
    expect(modelSchema({ kind: "Telo.JsonSchema", schema: inline }, ctx, "t")).toBe(inline);
    expect(modelSchema(inline, ctx, "t")).toBe(inline);
    expect(modelSchema({ kind: "Telo.JsonSchema", name: "Todo", $ref: "telo:App/Todo" }, ctx, "t")).toBe(
      registry["telo:App/Todo"],
    );
  });

  it("is refused when the slot names no registered shape", () => {
    expect(() => modelSchema({ kind: "Telo.JsonSchema", name: "Missing" }, ctx, "Ui.Table 't'")).toThrow(
      "Ui.Table 't': 'model' does not name a data shape.",
    );
  });
});

describe("a scalar property", () => {
  it("is one plain value, nullable or listed, and never a container", () => {
    expect(isScalar({ type: ["string", "null"] })).toBe(true);
    expect(isScalar({ enum: ["a", "b"] })).toBe(true);
    expect(isScalar({ type: ["string", "array"] })).toBe(false);
    expect(isScalar({})).toBe(false);
  });
});
