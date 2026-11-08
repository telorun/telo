import type { InvokeContext, ResourceContext } from "@telorun/sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ComparisonFailure } from "./comparison-failure.js";
import { buildRecord, thresholdBreaches } from "./comparison-record.js";
import { renderBreach, renderComparisonTables, renderErrorGroups } from "./comparison-report.js";
import { ComparisonRounds } from "./comparison-rounds.js";
import { readSettings, settingsProblems, type ComparisonManifest, type ComparisonSettings } from "./comparison-settings.js";
import { formatCpuList, splitCores } from "./core-split.js";
import { allowedCpusOf, hostRecord, pinProcess, readHostCpuFacts, teloCliVersion } from "./host-probe.js";
import type { SubjectProcess } from "./subject-process.js";

// Loaded on the main thread only: the bundle is also the load generator threads' entry, and a
// worker has no kernel for the SDK to resolve against.
type Sdk = typeof import("@telorun/sdk");
let sdkModule: Promise<Sdk> | undefined;
const loadSdk = (): Promise<Sdk> => (sdkModule ??= import("@telorun/sdk"));

class BenchmarkComparison {
  constructor(
    private readonly settings: ComparisonSettings,
    private readonly ctx: ResourceContext,
    private readonly sdk: Sdk,
  ) {}

  private fail(failure: ComparisonFailure): Error {
    return new this.sdk.RuntimeError(failure.code, failure.message);
  }

  async run(invoke?: InvokeContext): Promise<void> {
    try {
      await this.measure(invoke);
    } catch (error) {
      if (error instanceof ComparisonFailure) throw this.fail(error);
      throw error;
    }
  }

  private async measure(invoke: InvokeContext | undefined): Promise<void> {
    const name = this.settings.name;
    const split = splitCores(readHostCpuFacts());
    if (!split.ok) {
      throw new ComparisonFailure(
        "ERR_BENCHMARK_PLATFORM_UNSUPPORTED",
        `Benchmark.Comparison "${name}" samples process memory and CPU from /proc and pins cores with taskset, ` +
          `which this host (${split.reason}) does not have. Run it on Linux with at least 2 physical cores.`,
      );
    }
    const version = teloCliVersion() ?? null;
    if (version === null) {
      this.ctx.log.warn(
        `Benchmark.Comparison "${name}": this process was not started by the telo CLI, so the record's teloVersion is null`,
      );
    }
    const host = hostRecord(split.generatorCpus, split.subjectCpus);
    const signal = invoke?.cancellation.signal;

    let active: SubjectProcess | undefined;
    const killActive = () => active?.kill();
    const onAbort = () => killActive();
    signal?.addEventListener("abort", onAbort);
    process.on("exit", killActive);
    const originalCpus = allowedCpusOf("self");
    pinProcess(split.generatorCpus);
    let samples;
    try {
      samples = await new ComparisonRounds(this.settings, {
        generatorCpus: split.generatorCpus,
        subjectCpus: split.subjectCpus,
        clockTicks: split.clockTicks,
        signal,
        env: this.ctx.env,
        progress: (message) =>
          this.ctx.log.info(`Benchmark.Comparison "${name}": ${message}`, {
            generatorCpus: formatCpuList(split.generatorCpus),
            subjectCpus: formatCpuList(split.subjectCpus),
          }),
        onActive: (subject) => {
          active = subject;
        },
      }).run();
    } finally {
      signal?.removeEventListener("abort", onAbort);
      process.off("exit", killActive);
      pinProcess(originalCpus);
    }

    const record = buildRecord(this.settings, samples, version, host);
    if (this.settings.reportFile) {
      mkdirSync(dirname(this.settings.reportFile), { recursive: true });
      writeFileSync(this.settings.reportFile, JSON.stringify(record) + "\n");
    }
    const useColor = (this.ctx.stdout as { isTTY?: boolean }).isTTY ?? false;
    const bold = (t: string) => (useColor ? `\x1b[1m${t}\x1b[0m` : t);
    this.ctx.stdout.write(renderComparisonTables(record, this.settings, bold));
    this.ctx.stdout.write(renderErrorGroups(record, bold));

    const breaches = thresholdBreaches(record, this.settings.thresholds);
    if (breaches.length > 0) {
      this.ctx.stderr.write("\n" + breaches.map(renderBreach).join("\n") + "\n");
      this.ctx.requestExit(1);
    }
  }
}

export function register() {}

export async function create(resource: ComparisonManifest, ctx: ResourceContext) {
  const sdk = await loadSdk();
  const settings = readSettings(resource, sdk.durationMs);
  const problems = settingsProblems(settings);
  if (problems.length > 0) {
    throw new sdk.RuntimeError(
      "ERR_BENCHMARK_COMPARISON_INVALID",
      `Benchmark.Comparison "${settings.name}": ${problems.join("; ")}.`,
    );
  }
  return new BenchmarkComparison(settings, ctx, sdk);
}
