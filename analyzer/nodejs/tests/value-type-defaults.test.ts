import { isCelDuration } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { valueTypeDefaultFiller } from "../src/value-type-defaults.js";

/** Where AJV's `useDefaults` would write a default at an instance-typed slot, the
 *  filler writes it first, decoded — and nowhere else. */
const duration = { "x-telo-type": "Telo.Duration", default: "5s" };

describe("valueTypeDefaultFiller", () => {
  it("fills through $ref, allOf, items and a default object, never inside a union, and leaves other defaults alone", () => {
    const schema = {
      type: "object",
      $defs: { Wait: { type: "object", properties: { wait: duration } } },
      properties: {
        viaRef: { $ref: "#/$defs/Wait" },
        viaAllOf: { allOf: [{ $ref: "#/$defs/Wait" }] },
        list: { type: "array", items: { type: "object", properties: { wait: duration } } },
        created: { type: "object", default: {}, properties: { wait: duration } },
        union: { anyOf: [{ type: "object", properties: { wait: duration } }] },
        port: { "x-telo-type": "Telo.TcpPort", default: 8080 },
        label: { type: "string", default: "x" },
      },
    };
    const value: Record<string, any> = { viaRef: {}, viaAllOf: {}, list: [{}, { wait: "kept" }], union: {} };
    valueTypeDefaultFiller(schema)!(value);

    expect(isCelDuration(value.viaRef.wait)).toBe(true);
    expect(isCelDuration(value.viaAllOf.wait)).toBe(true);
    expect(isCelDuration(value.list[0].wait)).toBe(true);
    expect(value.list[1].wait).toBe("kept");
    expect(isCelDuration(value.created.wait)).toBe(true);
    expect(value.union).toEqual({});
    expect("port" in value || "label" in value).toBe(false);
  });
});
