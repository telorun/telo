import { describe, expect, it } from "vitest";
import { decodeRow, modelProperties } from "../src/model-properties.js";

/**
 * A stored row is read as a record valid against the model. What a NULL column
 * becomes is the property's to decide: `null` where it admits one, no key where
 * it is optional, its type's empty value where it is required.
 */
describe("a NULL column in a record read", () => {
  const read = (declared: Record<string, unknown>, required: boolean) =>
    decodeRow(modelProperties({ properties: { value: declared }, required: required ? ["value"] : [] }), {
      id: 1,
      value: null,
    });

  it.each([
    ["string", ""],
    ["integer", 0],
    ["number", 0],
    ["boolean", false],
    ["array", []],
    ["object", {}],
  ])("of a %s property is null where nullable, absent where optional, empty where required", (type, empty) => {
    expect(read({ type: [type, "null"] }, true)).toEqual({ id: 1, value: null });
    expect(read({ type }, false)).toEqual({ id: 1 });
    expect(read({ type }, true)).toEqual({ id: 1, value: empty });
  });

  it("of a property declaring no type is null, required or not", () => {
    expect(read({}, false)).toEqual({ id: 1, value: null });
    expect(read({ enum: [0, 1] }, true)).toEqual({ id: 1, value: null });
  });

  it("of a required property of several types is the empty value of the first listed", () => {
    expect(read({ type: ["integer", "string"] }, true)).toEqual({ id: 1, value: 0 });
  });
});
