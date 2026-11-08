import { describe, expect, it } from "vitest";
import { splitCores, type HostCpuFacts } from "../src/core-split.js";

// Pairs of SMT siblings (0,1) (2,3) (4,5), then single-thread cores 6 and 7.
const siblingsOf = (cpu: number) => (cpu < 6 ? [cpu & ~1, cpu | 1] : [cpu]);
const linux = (allowedCpus: number[], overrides: Partial<HostCpuFacts> = {}): HostCpuFacts => ({
  platform: "linux",
  hasProc: true,
  hasTaskset: true,
  clockTicks: 100,
  allowedCpus,
  siblingsOf,
  ...overrides,
});

describe("splitCores", () => {
  it("halves the whole cores, siblings together, the odd core to the subjects", () => {
    expect(splitCores(linux([0, 1, 2, 3, 4, 5]))).toEqual({
      ok: true,
      generatorCpus: [0, 1],
      subjectCpus: [2, 3, 4, 5],
      clockTicks: 100,
    });
  });

  it("leaves out a core only part of which this process may use", () => {
    expect(splitCores(linux([0, 2, 3, 6, 7]))).toMatchObject({ ok: true, generatorCpus: [2, 3], subjectCpus: [6, 7] });
  });

  it("refuses a host it cannot sample or pin, naming why", () => {
    expect(splitCores(linux([], { platform: "darwin" }))).toEqual({ ok: false, reason: "darwin" });
    expect(splitCores(linux([0, 1, 2, 3], { hasTaskset: false }))).toEqual({
      ok: false,
      reason: "linux, no taskset on PATH",
    });
    expect(splitCores(linux([0, 1, 2]))).toEqual({ ok: false, reason: "linux, 1 whole physical core available" });
  });
});
