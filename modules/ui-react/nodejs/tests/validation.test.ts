import { describe, expect, it } from "vitest";
import { validate } from "../src/browser/validation.js";

const messages = (schema: object, value: unknown) => validate(schema, value).map((finding) => `${finding.path.join(".")}: ${finding.message}`);

describe("the schema interpreter", () => {
  it.each([
    [{ type: "integer" }, 1.5, ": Must be integer"],
    [{ type: ["string", "null"] }, 3, ": Must be string or null"],
    [{ enum: ["a", "b"] }, "c", ": Must be one of: a, b"],
    [{ const: 3 }, 4, ": Must be 3"],
    [{ minLength: 3 }, "ab", ": Must be at least 3 characters"],
    [{ maxLength: 1 }, "ab", ": Must be at most 1 characters"],
    [{ pattern: "^[a-z]+$" }, "A1", ": Is not in the expected format"],
    [{ minimum: 2 }, 1, ": Must be at least 2"],
    [{ maximum: 2 }, 3, ": Must be at most 2"],
    [{ exclusiveMinimum: 2 }, 2, ": Must be greater than 2"],
    [{ exclusiveMaximum: 2 }, 2, ": Must be less than 2"],
    [{ multipleOf: 0.1 }, 0.25, ": Must be a multiple of 0.1"],
    [{ required: ["a"] }, {}, "a: Is required"],
    [{ properties: { a: { properties: { b: { type: "string" } } } } }, { a: { b: 1 } }, "a.b: Must be string"],
    [{ type: "array", items: { type: "string", minLength: 2 } }, ["ab", "c"], "1: Must be at least 2 characters"],
  ])("judges %j against %j", (schema, value, expected) => {
    expect(messages(schema, value)).toEqual([expected]);
  });

  it("passes what satisfies each keyword, and leaves keywords it does not read to the API", () => {
    const schema = { type: "object", required: ["n"], properties: { n: { type: "number", multipleOf: 0.1, minimum: 0 }, s: { type: "string", format: "email" } } };
    expect(messages(schema, { n: 0.3, s: "not an email" })).toEqual([]);
  });
});
