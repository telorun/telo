import { describe, expect, it } from "vitest";
import type { ComparisonRecord } from "../src/comparison-record.js";
import { thresholdBreaches } from "../src/comparison-record.js";
import { renderBreach, renderComparisonTables } from "../src/comparison-report.js";
import type { ComparisonSettings } from "../src/comparison-settings.js";

const flat = (median: number) => ({ median, min: median, max: median, cv: 0 });
const MB = 1024 * 1024;

const settings = {
  name: "leadIntake",
  rounds: 5,
  boots: 20,
  subjects: [],
  workloads: [{ name: "ping", durationMs: 30_000, warmupMs: 5_000, concurrency: 64, rate: 2000, requests: [], weights: [] }],
  reportFile: "/out/comparison.json",
  thresholds: [],
} satisfies ComparisonSettings;

const record: ComparisonRecord = {
  teloVersion: "0.112.0",
  host: { os: "ubuntu-24.04", cpus: 4, model: "AMD EPYC 7763", node: "22.11.0", generatorCpus: [0, 1], subjectCpus: [2, 3] },
  bootResults: [
    { subject: "teloObserved", coldMs: flat(631), warmMs: flat(401), startupMs: flat(297) },
    { subject: "node", coldMs: flat(142), warmMs: flat(139) },
  ],
  workloadResults: ["teloObserved", "node"].map((subject, i) => ({
    workload: "ping",
    subject,
    throughput: flat(i === 0 ? 11904.8 : 23012.7),
    generatorBound: i === 1,
    rate: 2000,
    p50Ms: flat(i === 0 ? 0.8 : 0.4),
    p99Ms: flat(i === 0 ? 2.9 : 1.2),
    cpuPerRequestMs: flat(i === 0 ? 0.09 : 0.04),
    rssBytes: i === 0 ? { idle: 84 * MB, peak: 126 * MB, after: 90 * MB } : { idle: 58 * MB, peak: 74 * MB, after: 61 * MB },
    errors: { count: 0, rate: 0, groups: [] },
  })),
};

describe("renderComparisonTables", () => {
  it("prints the boot and workload tables with the saturation mark and the run's footnote", () => {
    expect(renderComparisonTables(record, settings, (t) => t)).toBe(
      [
        "",
        "Boot      Subject       Cold   Warm   Startup span",
        "          teloObserved  631ms  401ms  297ms",
        "          node          142ms  139ms  -",
        "",
        "Workload  Subject       RPS (c=64)  p50@rate  p99@rate  CPU/req  RSS idle/peak/after  Errors",
        "ping      teloObserved  11904.8     0.8ms     2.9ms     0.09ms   84/126/90 MB         0.00%",
        "ping      node          23012.7*    0.4ms     1.2ms     0.04ms   58/74/61 MB          0.00%",
        "",
        "* generator-bound: the load generator saturated its cores; this throughput is a lower bound.",
        "Rates: ping 2000/s. Generator on CPUs 0,1; subjects on CPUs 2,3. Median of 5 rounds; spread is in the report file.",
        "",
      ].join("\n"),
    );
  });
});

describe("thresholdBreaches", () => {
  it("compares a latency limit with the median at rate, for the subjects it names", () => {
    const breaches = thresholdBreaches(record, [
      { workload: "ping", subject: undefined, errorRate: undefined, p50: undefined, p99: 2 },
    ]);
    expect(breaches.map(renderBreach)).toEqual(["THRESHOLD FAIL [ping/teloObserved] p99 2.90ms > 2.00ms"]);
  });
});
