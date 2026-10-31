import { describe, expect, it } from "vitest";
import { declaredCelViewAt, declaredViewPaths } from "../src/declared-cel-view.js";

const schema = {
  type: "object",
  properties: {
    factor: { type: "integer" },
    ratio: { type: "number" },
    jobs: {
      type: "object",
      additionalProperties: { type: "object", properties: { factor: { type: "integer" } } },
    },
    list: { type: "array", items: { type: "object", properties: { factor: { type: "integer" } } } },
    named: { type: "object", properties: { a: { type: "string" } }, additionalProperties: { type: "integer" } },
  },
};
const paths = declaredViewPaths(schema);

describe("the CEL view of a declared value", () => {
  it("reads a declared integer as an int64 at the root, below a map value and below a list item", () => {
    const written = { factor: 3, ratio: 2, jobs: { a: { factor: 4 } }, list: [{ factor: 5 }] };
    expect(declaredCelViewAt(written, [], paths)).toEqual({
      factor: 3n,
      ratio: 2,
      jobs: { a: { factor: 4n } },
      list: [{ factor: 5n }],
    });
    expect(written.factor).toBe(3);
  });

  it("reads a value written below the root through the keys that locate it", () => {
    expect(declaredCelViewAt({ factor: 4 }, ["jobs", "a"], paths)).toEqual({ factor: 4n });
    expect(declaredCelViewAt(5, ["list", 0, "factor"], paths)).toBe(5n);
  });

  it("leaves a fractional number at an integer slot as it is, and an undeclared map value alone", () => {
    expect(declaredCelViewAt({ factor: 3.5 }, ["jobs", "a"], paths)).toEqual({ factor: 3.5 });
    expect(declaredCelViewAt({ a: "x", b: 1 }, ["named"], paths)).toEqual({ a: "x", b: 1 });
  });
});
