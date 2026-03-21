import { Static, Type } from "@sinclair/typebox";
import type { Invocable, KindRef, ResourceContext } from "@telorun/sdk";

const ThresholdEntry = Type.Object({
  scenario: Type.Optional(Type.String()),
  p50: Type.Optional(Type.Number()),
  p95: Type.Optional(Type.Number()),
  p99: Type.Optional(Type.Number()),
  errorRate: Type.Optional(Type.Number()),
});

const ScenarioEntry = Type.Object(
  {
    name: Type.String(),
    weight: Type.Optional(Type.Integer()),
    invoke: Type.Unsafe<KindRef<Invocable>>({ "x-telo-ref": "kernel#Invocable" }),
    validate: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

export const schema = Type.Object({
  metadata: Type.Object({ name: Type.String() }),
  duration: Type.Optional(Type.String()),
  requests: Type.Optional(Type.Integer()),
  concurrency: Type.Optional(Type.Integer()),
  warmup: Type.Optional(Type.String()),
  report: Type.Optional(
    Type.Object({
      format: Type.Optional(Type.Union([Type.Literal("table"), Type.Literal("json")])),
      thresholds: Type.Optional(Type.Array(ThresholdEntry)),
    }),
  ),
  scenarios: Type.Array(ScenarioEntry),
});

type SuiteManifest = Static<typeof schema>;
type ScenarioEntry = Static<typeof ScenarioEntry>;

type ResolvedScenario = {
  scenarioName: string;
  kind: string;
  name: string;
  weight: number;
  validate?: string;
};

function parseDuration(str: string): number {
  const match = str.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m)$/);
  if (!match) throw new Error(`Invalid duration: "${str}". Use format like "30s", "1m", "500ms".`);
  const value = parseFloat(match[1]);
  switch (match[2]) {
    case "ms": return value;
    case "s":  return value * 1000;
    case "m":  return value * 60_000;
  }
  return value;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(Math.floor(p * sorted.length), sorted.length - 1);
  return sorted[idx];
}

function fmtMs(ms: number): string {
  return `${Math.round(ms)}ms`;
}

const useColor = process.stdout.isTTY;
const c = (code: string, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = (t: string) => c("1", t);
const green = (t: string) => c("32", t);
const red = (t: string) => c("31", t);
const dim = (t: string) => c("2", t);

class BenchmarkSuite {
  private resolved: ResolvedScenario[] = [];
  private cumulativeWeights: number[] = [];
  private totalWeight = 0;
  private samples = new Map<string, number[]>();
  private errorCounts = new Map<string, number>();
  private measureStart = 0;
  private measureEnd = 0;

  constructor(
    private resource: SuiteManifest,
    private ctx: ResourceContext,
  ) {}

  async init() {
    for (const scenario of this.resource.scenarios) {
      const uniqueName = `${this.resource.metadata.name}_${scenario.name}`;
      const ref = this.ctx.resolveChildren(scenario.invoke as any, uniqueName);
      this.resolved.push({
        scenarioName: scenario.name,
        kind: ref.kind,
        name: ref.name,
        weight: scenario.weight ?? 1,
        validate: scenario.validate,
      });
      this.samples.set(scenario.name, []);
      this.errorCounts.set(scenario.name, 0);
    }

    // Build cumulative weight array for O(n) selection
    let cum = 0;
    for (const s of this.resolved) {
      cum += s.weight;
      this.cumulativeWeights.push(cum);
    }
    this.totalWeight = cum;
  }

  async run() {
    const concurrency = this.resource.concurrency ?? 1;
    const warmupMs = this.resource.warmup ? parseDuration(this.resource.warmup) : 0;
    const warmupUntil = Date.now() + warmupMs;

    const stopCondition = this.makeStopCondition();

    process.stdout.write(
      dim(`Benchmarking ${this.resource.scenarios.length} scenario(s) with ${concurrency} worker(s)`) +
      (warmupMs > 0 ? dim(`, ${this.resource.warmup} warmup`) : "") +
      "\n",
    );

    await Promise.all(
      Array.from({ length: concurrency }, () => this.worker(stopCondition, warmupUntil)),
    );
    this.measureEnd = performance.now();

    this.printReport();
  }

  private async worker(stop: { done: () => boolean; tick: () => void }, warmupUntil: number) {
    while (!stop.done()) {
      const scenario = this.pickScenario();
      const t0 = performance.now();
      let result: unknown;
      let isError = false;
      try {
        result = await this.ctx.invoke(scenario.kind, scenario.name, {});
        if (scenario.validate) {
          const ok = this.ctx.expandValue(scenario.validate, { result });
          if (!ok) isError = true;
        }
      } catch {
        isError = true;
      }
      const latency = performance.now() - t0;

      if (Date.now() >= warmupUntil) {
        if (this.measureStart === 0) this.measureStart = performance.now() - latency;
        this.samples.get(scenario.scenarioName)!.push(latency);
        if (isError) {
          this.errorCounts.set(
            scenario.scenarioName,
            (this.errorCounts.get(scenario.scenarioName) ?? 0) + 1,
          );
        }
      }
      stop.tick();
    }
  }

  private pickScenario(): ResolvedScenario {
    const r = Math.random() * this.totalWeight;
    for (let i = 0; i < this.cumulativeWeights.length; i++) {
      if (r < this.cumulativeWeights[i]) return this.resolved[i];
    }
    return this.resolved[this.resolved.length - 1];
  }

  private makeStopCondition(): { done: () => boolean; tick: () => void } {
    if (this.resource.requests != null) {
      let remaining = this.resource.requests;
      return {
        done: () => remaining <= 0,
        tick: () => { remaining--; },
      };
    }
    if (this.resource.duration) {
      const deadline = Date.now() + parseDuration(this.resource.duration);
      return {
        done: () => Date.now() >= deadline,
        tick: () => {},
      };
    }
    // Default: 10 seconds
    const deadline = Date.now() + 10_000;
    return {
      done: () => Date.now() >= deadline,
      tick: () => {},
    };
  }

  private printReport() {
    const format = this.resource.report?.format ?? "table";
    const thresholds = this.resource.report?.thresholds ?? [];

    if (format === "json") {
      this.printJson(thresholds);
    } else {
      this.printTable(thresholds);
    }
  }

  private buildStats(scenarioName: string) {
    const raw = this.samples.get(scenarioName) ?? [];
    const errors = this.errorCounts.get(scenarioName) ?? 0;
    const total = raw.length + errors;
    const sorted = [...raw].sort((a, b) => a - b);
    const elapsedMs = this.measureEnd - this.measureStart;
    const rps = elapsedMs > 0 ? (raw.length / elapsedMs) * 1000 : 0;
    return {
      total,
      rps,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      errors,
      errorRate: total > 0 ? errors / total : 0,
    };
  }

  private printTable(thresholds: Static<typeof ThresholdEntry>[]) {
    const header = ["Scenario", "Reqs", "RPS", "p50", "p95", "p99", "Errors"];
    const rows: string[][] = [];

    for (const s of this.resolved) {
      const st = this.buildStats(s.scenarioName);
      rows.push([
        s.scenarioName,
        String(st.total),
        st.rps.toFixed(1),
        fmtMs(st.p50),
        fmtMs(st.p95),
        fmtMs(st.p99),
        `${(st.errorRate * 100).toFixed(2)}%`,
      ]);
    }

    const widths = header.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => r[i].length)),
    );

    const pad = (s: string, w: number) => s.padEnd(w);
    const line = header.map((h, i) => bold(pad(h, widths[i]))).join("  ");

    process.stdout.write("\n" + line + "\n");
    process.stdout.write(widths.map((w) => "-".repeat(w)).join("  ") + "\n");

    for (const row of rows) {
      process.stdout.write(row.map((cell, i) => pad(cell, widths[i])).join("  ") + "\n");
    }
    process.stdout.write("\n");

    this.enforceThresholds(thresholds);
  }

  private printJson(thresholds: Static<typeof ThresholdEntry>[]) {
    const result: Record<string, object> = {};
    for (const s of this.resolved) {
      result[s.scenarioName] = this.buildStats(s.scenarioName);
    }
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    this.enforceThresholds(thresholds);
  }

  private enforceThresholds(thresholds: Static<typeof ThresholdEntry>[]) {
    let failed = false;

    for (const t of thresholds) {
      const names = t.scenario
        ? [t.scenario]
        : this.resolved.map((s) => s.scenarioName);

      for (const name of names) {
        const st = this.buildStats(name);

        if (t.p50 != null && st.p50 > t.p50) {
          process.stderr.write(red(`THRESHOLD FAIL [${name}] p50 ${fmtMs(st.p50)} > ${fmtMs(t.p50)}\n`));
          failed = true;
        }
        if (t.p95 != null && st.p95 > t.p95) {
          process.stderr.write(red(`THRESHOLD FAIL [${name}] p95 ${fmtMs(st.p95)} > ${fmtMs(t.p95)}\n`));
          failed = true;
        }
        if (t.p99 != null && st.p99 > t.p99) {
          process.stderr.write(red(`THRESHOLD FAIL [${name}] p99 ${fmtMs(st.p99)} > ${fmtMs(t.p99)}\n`));
          failed = true;
        }
        if (t.errorRate != null && st.errorRate > t.errorRate) {
          process.stderr.write(
            red(`THRESHOLD FAIL [${name}] errorRate ${(st.errorRate * 100).toFixed(2)}% > ${(t.errorRate * 100).toFixed(2)}%\n`),
          );
          failed = true;
        }
      }
    }

    if (!failed) {
      process.stdout.write(green("All thresholds passed.\n"));
    } else {
      this.ctx.requestExit(1);
    }
  }
}

export function register() {}

export async function create(resource: SuiteManifest, ctx: ResourceContext) {
  const suite = new BenchmarkSuite(resource, ctx);
  return suite as any;
}
