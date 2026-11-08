import { describe, expect, it } from "vitest";
import { buildRecord, GENERATOR_BOUND_UTILIZATION } from "../src/comparison-record.js";
import { workloadKey, type ComparisonSamples, type WorkloadSamples } from "../src/comparison-rounds.js";
import type { ComparisonSettings } from "../src/comparison-settings.js";
import { ErrorGroups } from "../src/error-groups.js";

const subject = (name: string) => ({
  name,
  command: "node",
  args: [],
  env: {},
  cwd: "/subjects",
  readinessUrl: "http://127.0.0.1:1/",
  bootTimeoutMs: 60_000,
  caches: [],
  stateDirectoryEnv: undefined,
  traceFile: undefined,
});

const settings = {
  name: "utilization",
  rounds: 3,
  boots: 1,
  subjects: [subject("busy"), subject("idle")],
  workloads: [{ name: "hello", durationMs: 1_000, warmupMs: 0, concurrency: 8, requests: [], weights: [] }],
  reportFile: undefined,
  thresholds: [],
} satisfies ComparisonSettings;

function workload(generatorUtilization: number[]): WorkloadSamples {
  return {
    throughput: generatorUtilization.map(() => 1000),
    generatorUtilization,
    p50Ms: [],
    p99Ms: [],
    cpuPerRequestMs: [],
    rssIdle: [],
    rssPeak: [],
    rssAfter: [],
    errors: new ErrorGroups(),
    requests: 3000,
  };
}

describe("generator-bound throughput", () => {
  it("is marked when the generator's median utilization reaches the bound, and only then", () => {
    const samples: ComparisonSamples = {
      boots: new Map([
        ["busy", { coldMs: [1], warmMs: [1], startupMs: [] }],
        ["idle", { coldMs: [1], warmMs: [1], startupMs: [] }],
      ]),
      workloads: new Map([
        // One round below the bound does not move the median.
        [workloadKey("hello", "busy"), workload([0.97, GENERATOR_BOUND_UTILIZATION, 0.4])],
        [workloadKey("hello", "idle"), workload([0.95, 0.5, 0.6])],
      ]),
    };
    const host = { os: "linux", cpus: 4, model: "test", node: "24.0.0", generatorCpus: [0, 1], subjectCpus: [2, 3] };
    const record = buildRecord(settings, samples, null, host);
    expect(record.workloadResults.map((r) => [r.subject, r.generatorBound])).toEqual([
      ["busy", true],
      ["idle", false],
    ]);
  });
});
