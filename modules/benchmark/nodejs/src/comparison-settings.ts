import type { PreparedRequest } from "./load-worker.js";

export const DEFAULT_ROUNDS = 5;
export const DEFAULT_BOOTS = 20;
export const DEFAULT_BOOT_TIMEOUT_MS = 60_000;

/** The manifest as the kernel hands it to the controller. */
export interface ComparisonManifest {
  metadata: { name: string };
  rounds?: number | bigint;
  boots?: number | bigint;
  subjects: Array<{
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd: string;
    readiness?: { url: string };
    bootTimeout?: unknown;
    caches?: string[];
    stateDirectory?: { env: string };
    traceFile?: string;
  }>;
  workloads?: Array<{
    name: string;
    duration: unknown;
    warmup?: unknown;
    concurrency: number | bigint;
    rate?: number | bigint;
    requests: Array<{
      method?: string;
      url: string;
      weight?: number | bigint;
      headers?: Record<string, string>;
      body?: unknown;
      expect?: { status: number | bigint };
    }>;
  }>;
  report?: {
    file?: string;
    thresholds?: Array<{
      workload?: string;
      subject?: string;
      errorRate?: number;
      p50?: number;
      p99?: number;
    }>;
  };
}

export interface SubjectSettings {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  readinessUrl: string | undefined;
  bootTimeoutMs: number;
  caches: string[];
  stateDirectoryEnv: string | undefined;
  traceFile: string | undefined;
}

export interface WorkloadSettings {
  name: string;
  durationMs: number;
  warmupMs: number;
  concurrency: number;
  rate: number | undefined;
  requests: PreparedRequest[];
  weights: number[];
}

export interface ThresholdSettings {
  workload: string | undefined;
  subject: string | undefined;
  errorRate: number | undefined;
  p50: number | undefined;
  p99: number | undefined;
}

export interface ComparisonSettings {
  name: string;
  rounds: number;
  boots: number;
  subjects: SubjectSettings[];
  workloads: WorkloadSettings[];
  reportFile: string | undefined;
  thresholds: ThresholdSettings[];
}

/** A duration field in ms, or undefined when the value is not a duration. */
export type DurationReader = (value: unknown) => number | undefined;

function count(value: number | bigint | undefined, fallback: number): number {
  return value === undefined ? fallback : Number(value);
}

function encodeBody(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  return JSON.stringify(body, (key, v) => (typeof v === "bigint" ? Number(v) : v));
}

export function readSettings(manifest: ComparisonManifest, readDuration: DurationReader): ComparisonSettings {
  const name = manifest.metadata.name;
  const duration = (value: unknown, fallback: number | undefined, field: string): number => {
    if (value === undefined || value === null) {
      if (fallback === undefined) throw new Error(`Benchmark.Comparison "${name}": ${field} is required`);
      return fallback;
    }
    const ms = readDuration(value);
    if (ms === undefined) throw new Error(`Benchmark.Comparison "${name}": ${field} must be a duration`);
    return ms;
  };
  return {
    name,
    rounds: count(manifest.rounds, DEFAULT_ROUNDS),
    boots: count(manifest.boots, DEFAULT_BOOTS),
    subjects: manifest.subjects.map((s) => ({
      name: s.name,
      command: s.command,
      args: s.args ?? [],
      env: s.env ?? {},
      cwd: s.cwd,
      readinessUrl: s.readiness?.url,
      bootTimeoutMs: duration(s.bootTimeout, DEFAULT_BOOT_TIMEOUT_MS, `subject "${s.name}" bootTimeout`),
      caches: s.caches ?? [],
      stateDirectoryEnv: s.stateDirectory?.env,
      traceFile: s.traceFile,
    })),
    workloads: (manifest.workloads ?? []).map((w) => ({
      name: w.name,
      durationMs: duration(w.duration, undefined, `workload "${w.name}" duration`),
      warmupMs: duration(w.warmup, 0, `workload "${w.name}" warmup`),
      concurrency: Number(w.concurrency),
      rate: w.rate === undefined ? undefined : Number(w.rate),
      requests: w.requests.map((r) => ({
        method: r.method ?? "GET",
        url: r.url,
        headers: r.headers ?? {},
        body: encodeBody(r.body),
        expectStatus: r.expect === undefined ? undefined : Number(r.expect.status),
      })),
      weights: w.requests.map((r) => count(r.weight, 1)),
    })),
    reportFile: manifest.report?.file,
    thresholds: (manifest.report?.thresholds ?? []).map((t) => ({
      workload: t.workload,
      subject: t.subject,
      errorRate: t.errorRate === undefined ? undefined : Number(t.errorRate),
      p50: t.p50 === undefined ? undefined : Number(t.p50),
      p99: t.p99 === undefined ? undefined : Number(t.p99),
    })),
  };
}

/**
 * What the kind's resource rules refuse, checked again when the resource is created: a
 * comparison declared where `telo check` does not reach still never runs half-configured.
 */
export function settingsProblems(settings: ComparisonSettings): string[] {
  const problems: string[] = [];
  const duplicates = (names: string[]) => names.filter((n, i) => names.indexOf(n) !== i);
  for (const n of new Set(duplicates(settings.subjects.map((s) => s.name)))) {
    problems.push(`two subjects are named "${n}"`);
  }
  for (const n of new Set(duplicates(settings.workloads.map((w) => w.name)))) {
    problems.push(`two workloads are named "${n}"`);
  }
  if (settings.workloads.length > 0) {
    for (const s of settings.subjects) {
      if (s.readinessUrl === undefined) {
        problems.push(`subject "${s.name}" names no readiness url, so it runs to exit and cannot serve the workloads`);
      }
    }
  }
  for (const t of settings.thresholds) {
    const label = `the threshold for ${t.workload ?? "every workload"}/${t.subject ?? "every subject"}`;
    const matched = settings.workloads.filter((w) => t.workload === undefined || w.name === t.workload);
    if (matched.length === 0) {
      problems.push(
        t.workload === undefined
          ? `${label} has no workload to judge`
          : `${label} names workload "${t.workload}", which this comparison does not declare`,
      );
    }
    if (t.subject !== undefined && !settings.subjects.some((s) => s.name === t.subject)) {
      problems.push(`${label} names subject "${t.subject}", which this comparison does not declare`);
    }
    if ((t.p50 !== undefined || t.p99 !== undefined) && matched.some((w) => w.rate === undefined)) {
      problems.push(`${label} sets a latency limit, but a workload it judges states no rate`);
    }
  }
  return problems;
}
