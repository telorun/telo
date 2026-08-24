import { describe, expect, it } from "vitest";
import { resolveSiblingTypedProp, SIBLING_TYPE_KEY } from "./sibling-typed-field";

const defaultSlot = {
  title: "default",
  [SIBLING_TYPE_KEY]: { field: "type", only: ["string", "integer", "number", "boolean"] },
};

describe("resolveSiblingTypedProp", () => {
  it("takes the type the sibling declares", () => {
    expect(resolveSiblingTypedProp(defaultSlot, { type: "integer" })).toMatchObject({
      title: "default",
      type: "integer",
    });
    expect(resolveSiblingTypedProp(defaultSlot, { type: "boolean" })?.type).toBe("boolean");
  });

  it("hides the field while the sibling declares nothing", () => {
    // Guessing a type here is the unsafe write the annotation exists to
    // prevent — a text input would put "8080" into an integer entry.
    expect(resolveSiblingTypedProp(defaultSlot, {})).toBeNull();
    expect(resolveSiblingTypedProp(defaultSlot, undefined)).toBeNull();
    expect(resolveSiblingTypedProp(defaultSlot, { type: 7 })).toBeNull();
  });

  it("hides the field for a type outside the editable set", () => {
    // An untyped object slot falls through to the form's JSON-SCHEMA editor,
    // which writes a schema declaration where a value belongs.
    expect(resolveSiblingTypedProp(defaultSlot, { type: "object" })).toBeNull();
    expect(resolveSiblingTypedProp(defaultSlot, { type: "array" })).toBeNull();
  });

  it("accepts any declared type when the annotation names no set", () => {
    const open = { [SIBLING_TYPE_KEY]: { field: "type" } };
    expect(resolveSiblingTypedProp(open, { type: "object" })?.type).toBe("object");
  });

  it("passes an unannotated property through untouched", () => {
    const plain = { type: "string", title: "env" };
    expect(resolveSiblingTypedProp(plain, { type: "integer" })).toBe(plain);
  });

  it("ignores a malformed annotation rather than acting on half of it", () => {
    expect(resolveSiblingTypedProp({ [SIBLING_TYPE_KEY]: "type" }, { type: "integer" })).toEqual({
      [SIBLING_TYPE_KEY]: "type",
    });
    expect(resolveSiblingTypedProp({ [SIBLING_TYPE_KEY]: { field: "" } }, {})).toEqual({
      [SIBLING_TYPE_KEY]: { field: "" },
    });
  });
});
