import assert from "node:assert/strict";
import { test } from "node:test";
import { featureTrend, linePath, parseJsonl, ratioTrend, summarize, type ComparisonRow, type FeatureRow } from "../src/components/benchmark-data.ts";

const spread = (median: number) => ({ median, min: median, max: median, cv: 0 });
const result = (subject: string, cpu: number, p99: number, throughput: number) => ({
  workload: "leads",
  subject,
  throughput: spread(throughput),
  generatorBound: false,
  rate: 1000,
  p50Ms: spread(1),
  p99Ms: spread(p99),
  cpuPerRequestMs: spread(cpu),
  rssBytes: { idle: 1, peak: 2, after: 1 },
});
const row = (commit: string, teloCpu: number): ComparisonRow => ({
  commit,
  teloVersion: "0.1.0",
  host: null,
  bootResults: [],
  workloadResults: [result("telo", teloCpu, 12, 900), result("node", 1, 6, 1800)],
});

test("the headline ratios and the throughput ratio are telo over node", () => {
  const [leads] = summarize(row("abc", 1.5));
  assert.deepEqual([leads.cpuRatio, leads.p99Ratio, leads.throughputRatio], [1.5, 2, 0.5]);
});

test("a trend lists each run's ratio in order", () => {
  const points = ratioTrend([row("aaaaaaaa", 1), row("bbbbbbbb", 2)], "leads", "cpuRatio");
  assert.deepEqual(points, [{ label: "aaaaaaa", value: 1 }, { label: "bbbbbbb", value: 2 }]);
});

test("a feature trend uses the largest size every run completed", () => {
  const run = (sizes: number[]): FeatureRow => ({
    teloVersion: null,
    feature: "f",
    sizes: sizes.map((n) => ({ n, runWarmMs: spread(n * 10), checkWarmMs: spread(n) }) as FeatureRow["sizes"][number]),
  });
  const trend = featureTrend([run([1, 2, 4]), run([1, 2])], "f", "runWarmMs");
  assert.equal(trend.n, 2);
  assert.deepEqual(trend.points.map((p) => p.value), [20, 20]);
});

test("a malformed line is an error naming the file and line", () => {
  assert.throws(() => parseJsonl("comparison.jsonl", '{"a":1}\nnope\n'), /comparison\.jsonl line 2 is not JSON/);
});

test("a line path spans the box", () => {
  const { path } = linePath([{ label: "", value: 0 }, { label: "", value: 10 }], 100, 50, 0);
  assert.equal(path, "M0.0 50.0 L100.0 0.0");
});
