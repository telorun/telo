import { describe, expect, it } from "vitest";
import { mergePatch } from "../src/merge-patch.js";

describe("mergePatch (RFC 7396)", () => {
  it("merges an object member by member, a null removing the member", () => {
    expect(mergePatch({ a: { b: 1, c: 2 }, d: 3 }, { a: { b: 9, c: null, e: 4 } })).toEqual({ a: { b: 9, e: 4 }, d: 3 });
  });

  it("replaces a list or a scalar whole and builds an object over a non-object", () => {
    expect(mergePatch({ tags: ["a", "b"] }, { tags: ["c"] })).toEqual({ tags: ["c"] });
    expect(mergePatch(null, { a: { b: null, c: 1 } })).toEqual({ a: { c: 1 } });
  });

  it("does not let a __proto__ member reach the prototype", () => {
    const merged = mergePatch({}, JSON.parse('{"__proto__":{"x":1}}')) as Record<string, unknown>;
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(Object.keys(merged)).toEqual(["__proto__"]);
  });
});
