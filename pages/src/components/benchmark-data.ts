// Reads the benchmark history files (benchmarks/history) into the figures the results page shows.
// Pure functions over parsed records, so the page and its test share one reading.

export const HISTORY_BASE = "https://raw.githubusercontent.com/telorun/telo/benchmark-results";

export interface Spread {
  median: number;
  min: number;
  max: number;
  cv: number;
}

export interface WorkloadResult {
  workload: string;
  subject: string;
  throughput: Spread;
  generatorBound: boolean;
  rate: number | null;
  p50Ms: Spread | null;
  p99Ms: Spread | null;
  cpuPerRequestMs: Spread | null;
  rssBytes: { idle: number; peak: number; after: number } | null;
}

export interface BootResult {
  subject: string;
  coldMs: Spread;
  warmMs: Spread;
  startupMs?: Spread;
}

export interface ComparisonRow {
  commit?: string;
  teloVersion: string | null;
  host: { os?: string; cpus?: number; model?: string } | null;
  bootResults: BootResult[];
  workloadResults: WorkloadResult[];
}

export interface FeatureSize {
  n: number;
  runColdMs: Spread;
  runWarmMs: Spread;
  startupMs?: Spread;
  checkColdMs: Spread;
  checkWarmMs: Spread;
}

export interface FeatureRow {
  commit?: string;
  teloVersion: string | null;
  feature: string;
  sizes: FeatureSize[];
  firstFailure?: { n: number; code: string; message: string };
}

export function parseJsonl<T>(name: string, text: string): T[] {
  return text
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => line.trim() !== "")
    .map(({ line, number }) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw new Error(`${name} line ${number} is not JSON: ${(error as Error).message}`);
      }
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${name} line ${number} is not a JSON object`);
      }
      return value as T;
    });
}

export interface SubjectFigures {
  subject: string;
  throughput: number;
  generatorBound: boolean;
  p50Ms: number | null;
  p99Ms: number | null;
  cpuPerRequestMs: number | null;
  peakRssBytes: number | null;
}

export interface WorkloadSummary {
  workload: string;
  rate: number | null;
  subjects: SubjectFigures[];
  /** telo / node of the medians; null when either side has no figure. */
  cpuRatio: number | null;
  p99Ratio: number | null;
  throughputRatio: number | null;
}

function ratio(top: number | null | undefined, bottom: number | null | undefined): number | null {
  return typeof top === "number" && typeof bottom === "number" && top > 0 && bottom > 0 ? top / bottom : null;
}

function figureOf(results: WorkloadResult[], workload: string, subject: string, pick: (r: WorkloadResult) => number | null | undefined) {
  const found = results.find((r) => r.workload === workload && r.subject === subject);
  return found ? pick(found) : null;
}

export function ratiosOf(row: ComparisonRow, workload: string, subject: string, baseline: string) {
  const at = (name: string, pick: (r: WorkloadResult) => number | null | undefined) =>
    figureOf(row.workloadResults, workload, name, pick);
  const over = (pick: (r: WorkloadResult) => number | null | undefined) => ratio(at(subject, pick), at(baseline, pick));
  return {
    cpuRatio: over((r) => r.cpuPerRequestMs?.median),
    p99Ratio: over((r) => r.p99Ms?.median),
    throughputRatio: over((r) => r.throughput.median),
  };
}

export function summarize(row: ComparisonRow, subject = "telo", baseline = "node"): WorkloadSummary[] {
  const workloads = [...new Set(row.workloadResults.map((r) => r.workload))];
  return workloads.map((workload) => {
    const results = row.workloadResults.filter((r) => r.workload === workload);
    return {
      workload,
      rate: results[0]?.rate ?? null,
      subjects: results.map((r) => ({
        subject: r.subject,
        throughput: r.throughput.median,
        generatorBound: r.generatorBound,
        p50Ms: r.p50Ms?.median ?? null,
        p99Ms: r.p99Ms?.median ?? null,
        cpuPerRequestMs: r.cpuPerRequestMs?.median ?? null,
        peakRssBytes: r.rssBytes?.peak ?? null,
      })),
      ...ratiosOf(row, workload, subject, baseline),
    };
  });
}

export interface TrendPoint {
  label: string;
  value: number;
}

export function ratioTrend(rows: ComparisonRow[], workload: string, metric: "cpuRatio" | "p99Ratio", limit = 60): TrendPoint[] {
  const points: TrendPoint[] = [];
  for (const row of rows) {
    const value = ratiosOf(row, workload, "telo", "node")[metric];
    if (value !== null) points.push({ label: row.commit?.slice(0, 7) ?? "", value });
  }
  return points.slice(-limit);
}

/** The latest line of each feature, in the order features first appear. */
export function latestFeatures(rows: FeatureRow[]): FeatureRow[] {
  const latest = new Map<string, FeatureRow>();
  for (const row of rows) latest.set(row.feature, row);
  return [...latest.values()];
}

/** The largest size every given run completed, or null when they share none. */
export function commonSize(runs: FeatureRow[]): number | null {
  if (runs.length === 0) return null;
  const sets = runs.map((run) => new Set(run.sizes.map((s) => s.n)));
  const shared = [...sets[0]].filter((n) => sets.every((set) => set.has(n)));
  return shared.length > 0 ? Math.max(...shared) : null;
}

export function featureTrend(
  rows: FeatureRow[],
  feature: string,
  field: "runWarmMs" | "checkWarmMs",
  limit = 30,
): { n: number | null; points: TrendPoint[] } {
  const runs = rows.filter((r) => r.feature === feature).slice(-limit);
  const n = commonSize(runs);
  if (n === null) return { n, points: [] };
  return {
    n,
    points: runs.map((run) => ({ label: run.commit?.slice(0, 7) ?? "", value: run.sizes.find((s) => s.n === n)![field].median })),
  };
}

/** SVG path of a polyline through the points, scaled into a width x height box with `pad` inside. */
export function linePath(points: TrendPoint[], width: number, height: number, pad = 8): { path: string; min: number; max: number } {
  if (points.length === 0) return { path: "", min: 0, max: 0 };
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => (points.length === 1 ? width / 2 : pad + (i * (width - 2 * pad)) / (points.length - 1));
  const y = (v: number) => height - pad - ((v - min) * (height - 2 * pad)) / span;
  return {
    path: points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(" "),
    min,
    max,
  };
}
