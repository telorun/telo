import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatWord } from "../src/browser/texts.js";
import { holds, validate } from "../src/browser/validation.js";
import { englishWords } from "./words.js";

const messages = (schema: object, value: unknown) =>
  validate(schema, value).map((finding) => `${finding.path.join(".")}: ${formatWord(englishWords, finding.word.id, finding.word.values)}`);

describe("the schema interpreter", () => {
  it.each([
    [{ type: "integer" }, 1.5, ": Must be integer"],
    [{ type: ["string", "null"] }, 3, ": Must be string, null"],
    [{ enum: ["a", "b"] }, "c", ": Must be one of: a, b"],
    [{ const: 3 }, 4, ": Must be 3"],
    [{ minLength: 3 }, "ab", ": Must be at least 3 characters"],
    [{ maxLength: 1 }, "ab", ": Must be at most 1 character"],
    [{ pattern: "^[a-z]+$" }, "A1", ": Is not in the expected format"],
    [{ minimum: 2 }, 1, ": Must be at least 2"],
    [{ maximum: 2 }, 3, ": Must be at most 2"],
    [{ exclusiveMinimum: 2 }, 2, ": Must be greater than 2"],
    [{ exclusiveMaximum: 2 }, 2, ": Must be less than 2"],
    [{ multipleOf: 0.1 }, 0.25, ": Must be a multiple of 0.1"],
    [{ required: ["a"] }, {}, "a: Is required"],
    [{ properties: { a: { properties: { b: { type: "string" } } } } }, { a: { b: 1 } }, "a.b: Must be string"],
    [{ type: "array", items: { type: "string", minLength: 2 } }, ["ab", "c"], "1: Must be at least 2 characters"],
    [{ minItems: 1 }, [], ": Must have at least 1 item"],
    [{ maxItems: 1 }, [1, 2], ": Must have at most 1 item"],
    [{ uniqueItems: true }, [1, 1], ": Must not repeat an item"],
    [{ not: { const: 1 } }, 1, ": Is not allowed"],
    [{ anyOf: [{ const: 1 }, { const: 2 }] }, 3, ": Is not one of the allowed forms"],
    [{ allOf: [{ minimum: 2 }] }, 1, ": Must be at least 2"],
  ])("judges %j against %j", (schema, value, expected) => {
    expect(messages(schema, value)).toEqual([expected]);
  });

  it("passes what satisfies each keyword, and leaves keywords it does not read to the API", () => {
    const schema = { type: "object", required: ["n"], properties: { n: { type: "number", multipleOf: 0.1, minimum: 0 }, s: { type: "string", format: "email" } } };
    expect(messages(schema, { n: 0.3, s: "not an email" })).toEqual([]);
  });
});

/** `ui`'s conformance rows: what each keyword of the interpreted profile means,
 *  the missing-value cases included. */
const rows: { name: string; matches: object; value?: unknown; missing?: true; holds: boolean }[] = JSON.parse(
  readFileSync(new URL("../../../ui/conformance/match.json", import.meta.url), "utf8"),
).rows;

describe("a condition over the interpreted profile", () => {
  it.each(rows.map((row) => [row.name, row] as const))("%s", (name, row) => {
    expect(holds(row.matches, row.missing ? { present: false } : { present: true, value: row.value })).toBe(row.holds);
  });
});
