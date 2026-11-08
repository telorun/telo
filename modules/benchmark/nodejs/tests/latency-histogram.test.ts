import { describe, expect, it } from "vitest";
import { HISTOGRAM_RELATIVE_ERROR, LatencyHistogram } from "../src/latency-histogram.js";

function lcg(seed: number) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// Log-uniform from 0.05 ms to 5 s, so every decade of the range is exercised.
function sampleMs(n: number, seed: number): number[] {
  const rand = lcg(seed);
  return Array.from({ length: n }, () => 0.05 * 10 ** (rand() * 5));
}

function exact(sorted: number[], p: number): number {
  return sorted[Math.max(1, Math.ceil(p * sorted.length)) - 1];
}

describe("LatencyHistogram", () => {
  it("reports percentiles within the stated relative error of the exact ones", () => {
    const values = sampleMs(50_000, 1);
    const h = new LatencyHistogram();
    for (const v of values) h.recordMs(v);
    const sorted = [...values].sort((a, b) => a - b);
    for (const p of [0.5, 0.9, 0.95, 0.99, 0.999]) {
      const want = exact(sorted, p);
      const got = h.percentileMs(p);
      // microsecond rounding adds at most 0.0005 ms on top of the bucket error
      expect(Math.abs(got - want)).toBeLessThanOrEqual(want * HISTOGRAM_RELATIVE_ERROR + 0.0005);
    }
  });

  it("merging two histograms equals recording everything into one", () => {
    const values = sampleMs(20_000, 2);
    const whole = new LatencyHistogram();
    const left = new LatencyHistogram();
    const right = new LatencyHistogram();
    values.forEach((v, i) => {
      whole.recordMs(v);
      (i % 2 ? left : right).recordMs(v);
    });
    const merged = LatencyHistogram.from(structuredClone(left.snapshot()));
    merged.merge(structuredClone(right.snapshot()));
    expect(merged.snapshot()).toEqual(whole.snapshot());
  });

  it("keeps min and max exact and answers 0 when empty", () => {
    const h = new LatencyHistogram();
    expect(h.percentileMs(0.99)).toBe(0);
    h.recordMs(1.2345);
    h.recordMs(3000.5);
    expect(h.minMs()).toBe(1.235);
    expect(h.maxMs()).toBe(3000.5);
    expect(h.percentileMs(1)).toBe(3000.5);
  });
});
