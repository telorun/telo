import { workloadKey, type ComparisonSamples } from "./comparison-rounds.js";
import type { ComparisonSettings, ThresholdSettings } from "./comparison-settings.js";
import type { ErrorsRecord } from "./error-groups.js";
import type { HostRecord } from "./host-probe.js";
import { spread, type Spread } from "./spread.js";

/** Generator CPU use, over its cores, at which a throughput figure is only a lower bound. */
export const GENERATOR_BOUND_UTILIZATION = 0.9;

export interface BootResult {
  subject: string;
  coldMs: Spread;
  warmMs: Spread;
  startupMs?: Spread;
}

export interface WorkloadResult {
  workload: string;
  subject: string;
  throughput: Spread;
  generatorBound: boolean;
  /** The latency pass's rate; null with every figure of that pass when the workload states none. */
  rate: number | null;
  p50Ms: Spread | null;
  p99Ms: Spread | null;
  cpuPerRequestMs: Spread | null;
  rssBytes: { idle: number; peak: number; after: number } | null;
  errors: ErrorsRecord;
}

export interface ComparisonRecord {
  /** The telo CLI running the comparison; null when it was not started by one. */
  teloVersion: string | null;
  host: HostRecord;
  bootResults: BootResult[];
  workloadResults: WorkloadResult[];
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function rounded(values: number[], digits: number): Spread {
  const s = spread(values);
  return { median: round(s.median, digits), min: round(s.min, digits), max: round(s.max, digits), cv: round(s.cv, 3) };
}

export function buildRecord(
  settings: ComparisonSettings,
  samples: ComparisonSamples,
  teloVersion: string | null,
  host: HostRecord,
): ComparisonRecord {
  const bootResults = settings.subjects.map((s): BootResult => {
    const boot = samples.boots.get(s.name)!;
    const result: BootResult = { subject: s.name, coldMs: rounded(boot.coldMs, 3), warmMs: rounded(boot.warmMs, 3) };
    if (boot.startupMs.length > 0) result.startupMs = rounded(boot.startupMs, 3);
    return result;
  });
  const workloadResults: WorkloadResult[] = [];
  for (const w of settings.workloads) {
    for (const s of settings.subjects) {
      const ws = samples.workloads.get(workloadKey(w.name, s.name))!;
      const measured = w.rate !== undefined;
      workloadResults.push({
        workload: w.name,
        subject: s.name,
        throughput: rounded(ws.throughput, 1),
        generatorBound: spread(ws.generatorUtilization).median >= GENERATOR_BOUND_UTILIZATION,
        rate: w.rate ?? null,
        p50Ms: measured ? rounded(ws.p50Ms, 3) : null,
        p99Ms: measured ? rounded(ws.p99Ms, 3) : null,
        cpuPerRequestMs: measured ? rounded(ws.cpuPerRequestMs, 4) : null,
        rssBytes: measured
          ? {
              idle: Math.round(spread(ws.rssIdle).median),
              peak: Math.round(spread(ws.rssPeak).median),
              after: Math.round(spread(ws.rssAfter).median),
            }
          : null,
        errors: ws.errors.toRecord(ws.requests),
      });
    }
  }
  return { teloVersion, host, bootResults, workloadResults };
}

export interface ThresholdBreach {
  workload: string;
  subject: string;
  metric: "errorRate" | "p50" | "p99";
  actual: number;
  limit: number;
}

export function thresholdBreaches(record: ComparisonRecord, thresholds: ThresholdSettings[]): ThresholdBreach[] {
  const breaches: ThresholdBreach[] = [];
  for (const t of thresholds) {
    for (const r of record.workloadResults) {
      if (t.workload !== undefined && r.workload !== t.workload) continue;
      if (t.subject !== undefined && r.subject !== t.subject) continue;
      const at = { workload: r.workload, subject: r.subject };
      if (t.errorRate !== undefined && r.errors.rate > t.errorRate) {
        breaches.push({ ...at, metric: "errorRate", actual: r.errors.rate, limit: t.errorRate });
      }
      if (t.p50 !== undefined && r.p50Ms && r.p50Ms.median > t.p50) {
        breaches.push({ ...at, metric: "p50", actual: r.p50Ms.median, limit: t.p50 });
      }
      if (t.p99 !== undefined && r.p99Ms && r.p99Ms.median > t.p99) {
        breaches.push({ ...at, metric: "p99", actual: r.p99Ms.median, limit: t.p99 });
      }
    }
  }
  return breaches;
}
