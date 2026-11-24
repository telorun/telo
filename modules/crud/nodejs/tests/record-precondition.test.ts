import { describe, expect, it } from "vitest";
import { etagOf, preconditionHolds } from "../src/record-precondition.js";

describe("etagOf", () => {
  it("moves when only a date property changes", () => {
    const before = etagOf({ id: 1, dueOn: new Date("2026-08-01") });
    expect(etagOf({ id: 1, dueOn: new Date("2030-01-01") })).not.toBe(before);
    expect(etagOf({ id: 1, dueOn: new Date("2026-08-01") })).toBe(before);
  });

  it("moves when only bytes or a BigInt change", () => {
    expect(etagOf({ b: new Uint8Array([1]) })).not.toBe(etagOf({ b: new Uint8Array([2]) }));
    expect(etagOf({ n: 9007199254740993n })).not.toBe(etagOf({ n: 9007199254740992n }));
  });

  it("does not depend on key order", () => {
    expect(etagOf({ a: 1, b: { x: 1, y: 2 } })).toBe(etagOf({ b: { y: 2, x: 1 }, a: 1 }));
  });
});

describe("preconditionHolds", () => {
  it("states no precondition without a header and holds for a listed tag", () => {
    const tag = etagOf({ id: 1 });
    expect(preconditionHolds(undefined, tag)).toBe(true);
    expect(preconditionHolds(`"x", ${tag}`, tag)).toBe(true);
    expect(preconditionHolds('"x"', tag)).toBe(false);
  });
});
