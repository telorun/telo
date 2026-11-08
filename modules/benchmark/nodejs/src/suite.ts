import { Static, Type } from "@sinclair/typebox";
import type { Invocable, KindRef, ResourceContext } from "@telorun/sdk";
import { ErrorGroups, type ErrorsRecord } from "./error-groups.js";
import { LatencyHistogram } from "./latency-histogram.js";
import { classifyThrown, classifyValidateFailure } from "./suite-failure.js";
import { renderTextTable } from "./text-table.js";

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
    invoke: Type.Unsafe<KindRef<Invocable>>({ "x-telo-ref": "Telo.Invocable" }),
    inputs: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    validate: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);

const schema = Type.Object({
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
  // Runtime value is a CompiledValue (CEL), resolved per invocation via ctx.expandValue.
  validate?: unknown;
  inputs: Record<string, unknown>;
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

function fmtMs(ms: number): string {
  return `${Math.round(ms)}ms`;
}

class BenchmarkSuite {
  private resolved: ResolvedScenario[] = [];
  private cumulativeWeights: number[] = [];
  private totalWeight = 0;
  private latencies = new Map<string, LatencyHistogram>();
  private failures = new Map<string, ErrorGroups>();
  private measureStart = 0;
  private measureEnd = 0;

  private bold: (t: string) => string;
  private green: (t: string) => string;
  private red: (t: string) => string;
  private dim: (t: string) => string;

  constructor(
    private resource: SuiteManifest,
    private ctx: ResourceContext,
  ) {
    const useColor = (ctx.stdout as any).isTTY ?? false;
    const c = (code: string, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
    this.bold = (t: string) => c("1", t);
    this.green = (t: string) => c("32", t);
    this.red = (t: string) => c("31", t);
    this.dim = (t: string) => c("2", t);
  }

  async init() {
    for (const scenario of this.resource.scenarios) {
      const uniqueName = `${this.resource.metadata.name}_${scenario.name}`;
      const invoke = scenario.invoke as unknown as Record<string, unknown>;
      const ref = this.ctx.ensureKindRef(invoke, uniqueName);
      const inputs = (scenario.inputs as Record<string, unknown> | undefined) ?? {};
      this.resolved.push({
        scenarioName: scenario.name,
        kind: ref.kind,
        name: ref.name,
        weight: scenario.weight ?? 1,
        validate: scenario.validate,
        inputs,
      });
      this.latencies.set(scenario.name, new LatencyHistogram());
      this.failures.set(scenario.name, new ErrorGroups());
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

    // In JSON mode, keep stdout pure for downstream parsers; route progress
    // chatter to stderr. In table mode, the progress line precedes the human-
    // readable table on stdout as before.
    const progress = this.resource.report?.format === "json" ? this.ctx.stderr : this.ctx.stdout;
    progress.write(
      this.dim(`Benchmarking ${this.resource.scenarios.length} scenario(s) with ${concurrency} worker(s)`) +
      (warmupMs > 0 ? this.dim(`, ${this.resource.warmup} warmup`) : "") +
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
      let failure: { code: string; message: string; sample: string } | undefined;
      try {
        let result: unknown;
        result = await this.ctx.invoke(scenario.kind, scenario.name, scenario.inputs);
        if (scenario.validate) {
          // Require strict `true` — matches Http.Api `when:` semantics
          // (http-api-controller.ts) and prevents a non-boolean truthy CEL
          // result (e.g. an accidentally-string template) from masking a
          // failed scenario.
          const passed = this.ctx.expandValue(scenario.validate, { result }) === true;
          if (!passed) failure = classifyValidateFailure(result);
        }
      } catch (error) {
        failure = classifyThrown(error);
      }
      const latency = performance.now() - t0;

      if (Date.now() >= warmupUntil) {
        if (this.measureStart === 0) this.measureStart = performance.now() - latency;
        this.latencies.get(scenario.scenarioName)!.recordMs(latency);
        if (failure) {
          this.failures.get(scenario.scenarioName)!.record(failure.code, failure.message, failure.sample);
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
    const latencies = this.latencies.get(scenarioName)!;
    const total = latencies.count;
    const elapsedMs = this.measureEnd - this.measureStart;
    return {
      total,
      rps: elapsedMs > 0 ? (total / elapsedMs) * 1000 : 0,
      p50: latencies.percentileMs(0.5),
      p95: latencies.percentileMs(0.95),
      p99: latencies.percentileMs(0.99),
      errors: this.failures.get(scenarioName)!.toRecord(total),
    };
  }

  private printTable(thresholds: Static<typeof ThresholdEntry>[]) {
    const header = ["Scenario", "Reqs", "RPS", "p50", "p95", "p99", "Errors"];
    const rows: string[][] = [];
    const errorRows: string[][] = [];

    for (const s of this.resolved) {
      const st = this.buildStats(s.scenarioName);
      rows.push([
        s.scenarioName,
        String(st.total),
        st.rps.toFixed(1),
        fmtMs(st.p50),
        fmtMs(st.p95),
        fmtMs(st.p99),
        `${(st.errors.rate * 100).toFixed(2)}%`,
      ]);
      for (const g of st.errors.groups) {
        errorRows.push([s.scenarioName, g.code, String(g.count), g.message, g.sample]);
      }
    }

    this.ctx.stdout.write("\n" + renderTextTable(header, rows, this.bold) + "\n");
    if (errorRows.length > 0) {
      this.ctx.stdout.write(
        renderTextTable(["Scenario", "Code", "Count", "Message", "Sample"], errorRows, this.bold) + "\n",
      );
    }

    this.enforceThresholds(thresholds);
  }

  private printJson(thresholds: Static<typeof ThresholdEntry>[]) {
    const result: Record<string, { total: number; rps: number; p50: number; p95: number; p99: number; errors: ErrorsRecord }> = {};
    for (const s of this.resolved) {
      result[s.scenarioName] = this.buildStats(s.scenarioName);
    }
    this.ctx.stdout.write(JSON.stringify(result, null, 2) + "\n");
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
          this.ctx.stderr.write(this.red(`THRESHOLD FAIL [${name}] p50 ${fmtMs(st.p50)} > ${fmtMs(t.p50)}\n`));
          failed = true;
        }
        if (t.p95 != null && st.p95 > t.p95) {
          this.ctx.stderr.write(this.red(`THRESHOLD FAIL [${name}] p95 ${fmtMs(st.p95)} > ${fmtMs(t.p95)}\n`));
          failed = true;
        }
        if (t.p99 != null && st.p99 > t.p99) {
          this.ctx.stderr.write(this.red(`THRESHOLD FAIL [${name}] p99 ${fmtMs(st.p99)} > ${fmtMs(t.p99)}\n`));
          failed = true;
        }
        if (t.errorRate != null && st.errors.rate > t.errorRate) {
          this.ctx.stderr.write(
            this.red(`THRESHOLD FAIL [${name}] errorRate ${(st.errors.rate * 100).toFixed(2)}% > ${(t.errorRate * 100).toFixed(2)}%\n`),
          );
          failed = true;
        }
      }
    }

    if (failed) {
      this.ctx.requestExit(1);
    } else if (thresholds.length > 0) {
      // In JSON mode, the JSON object alone is the data on stdout; route the
      // status line to stderr so downstream parsers see clean output.
      const out = this.resource.report?.format === "json" ? this.ctx.stderr : this.ctx.stdout;
      out.write(this.green("All thresholds passed.\n"));
    }
  }
}

export function register() {}

export async function create(resource: SuiteManifest, ctx: ResourceContext) {
  const suite = new BenchmarkSuite(resource, ctx);
  return suite as any;
}
