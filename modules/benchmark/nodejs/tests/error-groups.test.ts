import { describe, expect, it } from "vitest";
import { ErrorGroups, MAX_SAMPLE_LENGTH } from "../src/error-groups.js";

describe("ErrorGroups", () => {
  it("groups by code and message, keeps the first sample and orders by count", () => {
    const g = new ErrorGroups();
    g.record("500", "a", "first");
    g.record("404", "b", "x");
    g.record("500", "a", "second");
    expect(g.toRecord(10)).toEqual({
      count: 3,
      rate: 0.3,
      groups: [
        { code: "500", message: "a", count: 2, sample: "first" },
        { code: "404", message: "b", count: 1, sample: "x" },
      ],
    });
  });

  it("bounds the number of groups and the sample length, counting every failure", () => {
    const g = new ErrorGroups(2);
    for (let i = 0; i < 100; i++) g.record("E", `message ${i}`, "s".repeat(10_000));
    const groups = g.snapshot();
    expect(groups).toHaveLength(3);
    expect(groups[2].code).toBe("OTHER");
    expect(groups.every((x) => x.sample.length <= MAX_SAMPLE_LENGTH)).toBe(true);
    expect(g.count).toBe(100);
  });

  it("merges snapshots from several threads", () => {
    const a = new ErrorGroups();
    const b = new ErrorGroups();
    a.record("500", "m", "sa");
    b.record("500", "m", "sb");
    b.record("502", "n");
    a.merge(structuredClone(b.snapshot()));
    expect(a.snapshot()).toEqual([
      { code: "500", message: "m", count: 2, sample: "sa" },
      { code: "502", message: "n", count: 1, sample: "" },
    ]);
  });
});
