import { describe, expect, it } from "vitest";
import { normalizeRefSlots } from "../src/manifest-schemas.js";

describe("normalizeRefSlots", () => {
  it("strips a legacy scalar `type` from a ref slot (the shape older modules pin)", () => {
    const legacy = { type: "array", items: { type: "string", "x-telo-ref": "std/mcp-server#Tools" } };
    expect(normalizeRefSlots(legacy)).toEqual({
      type: "array",
      items: { "x-telo-ref": "std/mcp-server#Tools" },
    });
  });

  it("leaves an object-typed ref slot intact (e.g. `inputType` accepts an inline schema or a ref)", () => {
    const schema = { type: "object", additionalProperties: true, "x-telo-ref": "telo#Type" };
    expect(normalizeRefSlots(schema)).toEqual(schema);
  });

  it("does not touch a non-ref scalar field", () => {
    const schema = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };
    expect(normalizeRefSlots(schema)).toEqual(schema);
  });

  it("strips the legacy `type` from a ref slot nested behind an anyOf branch", () => {
    const schema = {
      type: "object",
      properties: { invoke: { anyOf: [{ type: "string", "x-telo-ref": "telo#Invocable" }] } },
    };
    expect(normalizeRefSlots(schema)).toEqual({
      type: "object",
      properties: { invoke: { anyOf: [{ "x-telo-ref": "telo#Invocable" }] } },
    });
  });

  it("deep-clones rather than mutating the input", () => {
    const schema = { type: "object", properties: { port: { type: "integer" } } };
    const normalized = normalizeRefSlots(schema);
    expect(normalized).toEqual(schema);
    expect(normalized).not.toBe(schema);
  });
});
