import { describe, expect, it } from "vitest";
import { weightedCycle } from "../src/request-mix.js";

describe("weightedCycle", () => {
  it("sends each request as often as its weight, spread through the cycle", () => {
    expect(weightedCycle([3, 1])).toEqual([0, 0, 1, 0]);
    expect(weightedCycle([2, 2, 1])).toEqual([0, 1, 2, 0, 1]);
  });
});
