import { describe, expect, it } from "vitest";
import { spread } from "../src/spread.js";

describe("spread", () => {
  it("gives the median, extremes and coefficient of variation", () => {
    const s = spread([10, 30, 20, 40]);
    expect(s.median).toBe(25);
    expect(s.min).toBe(10);
    expect(s.max).toBe(40);
    expect(s.cv).toBeCloseTo(Math.sqrt(500 / 3) / 25, 10);
  });

  it("has no spread for one sample", () => {
    expect(spread([7])).toEqual({ median: 7, min: 7, max: 7, cv: 0 });
  });
});
