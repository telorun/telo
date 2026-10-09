import type { ResourceContext } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { headerOf, isScalar, modelSchema, modelShape, presentation, schemaAt } from "../src/model-schema.js";

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

describe("a member reached through a reference", () => {
  it("is refused when the reference leads back to itself", () => {
    const model = {
      type: "object",
      $defs: { A: { $ref: "#/$defs/B" }, B: { $ref: "#/$defs/A" } },
      properties: { owner: { $ref: "#/$defs/A" } },
    };
    const reader = { ctx, owner: "Ui.Table 't'" };
    expect(() => schemaAt(modelShape(model, reader, "model"), ["owner"], reader, "model")).toThrow(
      "Ui.Table 't': 'model.owner' holds a reference ('#/$defs/A') that leads back to itself, so it names no data shape. Point it at a shape that does not lead back here.",
    );
  });

  const reader = { ctx, owner: "Ui.Table 't'" };

  it("is read as written when it holds a `name` or a `schema` that is no reference", () => {
    const model = {
      type: "object",
      properties: {
        named: { type: "string", title: "Named", name: "Todo" },
        holder: { type: "integer", title: "Holder", schema: { type: "string", title: "Inner" } },
      },
    };
    const at = (member: string) => schemaAt(modelShape(model, reader, "model"), [member], reader, "model");
    expect([headerOf("named", at("named")), presentation(at("named"))]).toEqual(["Named", { type: "string" }]);
    expect([headerOf("holder", at("holder")), presentation(at("holder"))]).toEqual(["Holder", { type: "integer" }]);
  });

  it("is refused when a pointer token is no URI text", () => {
    const model = { type: "object", properties: { owner: { $ref: "#/$defs/100%" } } };
    expect(() => schemaAt(modelShape(model, reader, "model"), ["owner"], reader, "model")).toThrow(
      "Ui.Table 't': 'model.owner' holds a reference ('#/$defs/100%') that does not name a data shape. Declare that shape, or correct the reference.",
    );
  });
});
