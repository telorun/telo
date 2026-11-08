import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ComparisonFailure, formatDurationMs } from "./comparison-failure.js";
import type { ComparisonSettings, SubjectSettings, WorkloadSettings } from "./comparison-settings.js";
import { ErrorGroups } from "./error-groups.js";
import { runLoadPass } from "./load-pass.js";
import { ownCpuMs, sampleTree } from "./process-tree.js";
import { startupSpanMs } from "./startup-span.js";
import { answersAlready, BootFaultError, SubjectProcess } from "./subject-process.js";

/** Pause between readiness and the idle memory reading, and between the load's end and the after reading. */
export const RSS_SETTLE_MS = 1000;
/** Interval of the resident-memory sampling that finds the peak. */
export const RSS_SAMPLE_MS = 100;

export interface BootSamples {
  coldMs: number[];
  warmMs: number[];
  startupMs: number[];
}

export interface WorkloadSamples {
  throughput: number[];
  generatorUtilization: number[];
  p50Ms: number[];
  p99Ms: number[];
  cpuPerRequestMs: number[];
  rssIdle: number[];
  rssPeak: number[];
  rssAfter: number[];
  errors: ErrorGroups;
  requests: number;
}

export interface ComparisonSamples {
  boots: Map<string, BootSamples>;
  /** Keyed by `<workload>\n<subject>`. */
  workloads: Map<string, WorkloadSamples>;
}

export function workloadKey(workload: string, subject: string): string {
  return `${workload}\n${subject}`;
}

export interface RoundsHost {
  generatorCpus: number[];
  subjectCpus: number[];
  clockTicks: number;
  signal: AbortSignal | undefined;
  /** The environment the subjects inherit: the resource context's. */
  env: Record<string, string | undefined>;
  progress: (message: string) => void;
  /** Called with the running boot, and with undefined once it is gone. */
  onActive: (subject: SubjectProcess | undefined) => void;
}

type Where = { round: number; label: string };

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class ComparisonRounds {
  private readonly samples: ComparisonSamples = { boots: new Map(), workloads: new Map() };

  constructor(
    private readonly settings: ComparisonSettings,
    private readonly host: RoundsHost,
  ) {
    for (const s of settings.subjects) {
      samplesFor(this.samples.boots, s.name, () => ({ coldMs: [], warmMs: [], startupMs: [] }));
      for (const w of settings.workloads) {
        samplesFor(this.samples.workloads, workloadKey(w.name, s.name), () => ({
          throughput: [],
          generatorUtilization: [],
          p50Ms: [],
          p99Ms: [],
          cpuPerRequestMs: [],
          rssIdle: [],
          rssPeak: [],
          rssAfter: [],
          errors: new ErrorGroups(),
          requests: 0,
        }));
      }
    }
  }

  async run(): Promise<ComparisonSamples> {
    const { rounds, boots } = this.settings;
    for (let round = 1; round <= rounds; round++) {
      for (const subject of this.settings.subjects) {
        this.host.progress(`round ${round}/${rounds}, subject "${subject.name}": ${boots} cold and ${boots} warm boots`);
        const bootSamples = this.samples.boots.get(subject.name)!;
        for (let boot = 1; boot <= boots; boot++) {
          const cold = await this.measureBoot(subject, { round, label: `cold boot ${boot}` }, true);
          bootSamples.coldMs.push(cold.ms);
          const warm = await this.measureBoot(subject, { round, label: `warm boot ${boot}` }, false);
          bootSamples.warmMs.push(warm.ms);
          if (warm.startupMs !== undefined) bootSamples.startupMs.push(warm.startupMs);
        }
        for (const workload of this.settings.workloads) {
          this.host.progress(`round ${round}/${rounds}, subject "${subject.name}": workload "${workload.name}"`);
          await this.loadPasses(subject, workload, round);
        }
      }
    }
    return this.samples;
  }

  private where(where: Where): string {
    return `(round ${where.round}, ${where.label})`;
  }

  private bootFailure(subject: SubjectSettings, where: Where, fault: BootFaultError, during?: string): ComparisonFailure {
    const prefix = `Benchmark.Comparison "${this.settings.name}": subject "${subject.name}"`;
    const at = this.where(where);
    const timeout = formatDurationMs(subject.bootTimeoutMs);
    let what: string;
    const f = fault.fault;
    if (f.kind === "exited") {
      const ended = f.code !== null ? `exited with code ${f.code}` : `was ended by ${f.signal}`;
      if (during) what = `${ended} during the ${during}`;
      else if (subject.readinessUrl) what = `${ended} before ${subject.readinessUrl} answered`;
      else what = ended;
    } else if (f.kind === "timeout") {
      what = subject.readinessUrl
        ? `did not answer ${subject.readinessUrl} within ${timeout}`
        : `did not exit within ${timeout}`;
    } else {
      what = `did not exit within ${timeout} of SIGTERM and was killed`;
    }
    const stderr = fault.lastStderrLine !== undefined ? `. Last stderr line: ${fault.lastStderrLine}` : "";
    return new ComparisonFailure("ERR_BENCHMARK_BOOT_FAILED", `${prefix} ${what} ${at}${stderr}`);
  }

  // Starts one boot with a fresh state directory and an emptied trace file, and always
  // ends it: the process group is gone and the state directory removed when this returns.
  private async withBoot<T>(
    subject: SubjectSettings,
    where: Where,
    body: (proc: SubjectProcess) => Promise<T>,
  ): Promise<T> {
    const traceFile = subject.traceFile ? resolve(subject.cwd, subject.traceFile) : undefined;
    if (traceFile) rmSync(traceFile, { force: true });
    const stateDir = subject.stateDirectoryEnv ? mkdtempSync(join(tmpdir(), "telo-benchmark-state-")) : undefined;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.host.env)) if (v !== undefined) env[k] = v;
    Object.assign(env, subject.env);
    if (stateDir) env[subject.stateDirectoryEnv!] = stateDir;
    let proc: SubjectProcess | undefined;
    try {
      this.host.signal?.throwIfAborted();
      if (subject.readinessUrl && (await answersAlready(subject.readinessUrl))) {
        throw new ComparisonFailure(
          "ERR_BENCHMARK_BOOT_FAILED",
          `Benchmark.Comparison "${this.settings.name}": ${subject.readinessUrl} already answers before subject ` +
            `"${subject.name}" started ${this.where(where)}. Another process serves it; stop that process or move the subject to a free port.`,
        );
      }
      proc = new SubjectProcess({
        command: subject.command,
        args: subject.args,
        cwd: subject.cwd,
        env,
        cpus: this.host.subjectCpus,
      });
      this.host.onActive(proc);
      return await body(proc);
    } catch (error) {
      if (this.host.signal?.aborted) throw this.host.signal.reason;
      if (error instanceof BootFaultError) throw this.bootFailure(subject, where, error);
      throw error;
    } finally {
      if (proc && !proc.hasExited) {
        proc.kill();
        await proc.stop(subject.bootTimeoutMs).catch((error: unknown) => {
          if (!(error instanceof BootFaultError)) throw error;
        });
      }
      this.host.onActive(undefined);
      if (stateDir) rmSync(stateDir, { recursive: true, force: true });
    }
  }

  private async measureBoot(
    subject: SubjectSettings,
    where: Where,
    cold: boolean,
  ): Promise<{ ms: number; startupMs: number | undefined }> {
    if (cold) for (const cache of subject.caches) rmSync(resolve(subject.cwd, cache), { recursive: true, force: true });
    const ms = await this.withBoot(subject, where, async (proc) => {
      if (!subject.readinessUrl) return proc.untilExit(subject.bootTimeoutMs);
      const ready = await proc.untilReady(subject.readinessUrl, subject.bootTimeoutMs);
      await proc.stop(subject.bootTimeoutMs);
      return ready;
    });
    if (!subject.traceFile) return { ms, startupMs: undefined };
    const traceFile = resolve(subject.cwd, subject.traceFile);
    let text = "";
    try {
      text = readFileSync(traceFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const startupMs = startupSpanMs(text);
    if (startupMs === undefined) {
      throw new ComparisonFailure(
        "ERR_BENCHMARK_STARTUP_SPAN_MISSING",
        `Benchmark.Comparison "${this.settings.name}": subject "${subject.name}" names traceFile ${subject.traceFile}, ` +
          `but after round ${where.round}, ${where.label} it holds no "startup" span. Attach a Telo.LogTraceSink ` +
          `under tracing.sinks and a Telo.FileSink writing ${subject.traceFile} under logging.sinks.`,
      );
    }
    rmSync(traceFile, { force: true });
    return { ms, startupMs };
  }

  private async loadPasses(subject: SubjectSettings, workload: WorkloadSettings, round: number): Promise<void> {
    const samples = this.samples.workloads.get(workloadKey(workload.name, subject.name))!;
    const generatorCpus = this.host.generatorCpus.length;
    const ticks = this.host.clockTicks;

    const throughputWhere = { round, label: `throughput pass of ${workload.name}` };
    await this.withBoot(subject, throughputWhere, async (proc) => {
      await proc.untilReady(subject.readinessUrl!, subject.bootTimeoutMs);
      let cpuAtOpen = 0;
      let generatorCpuMs = 0;
      const pass = await runLoadPass({
        mode: "throughput",
        requests: workload.requests,
        weights: workload.weights,
        concurrency: workload.concurrency,
        rate: 0,
        warmupMs: workload.warmupMs,
        durationMs: workload.durationMs,
        generatorCpus,
        signal: this.host.signal,
        onWindow: (edge) => {
          if (edge === "open") cpuAtOpen = ownCpuMs(ticks);
          else if (edge === "close") generatorCpuMs = ownCpuMs(ticks) - cpuAtOpen;
        },
      });
      this.assertRunning(subject, throughputWhere, proc);
      samples.throughput.push((pass.responses * 1000) / pass.windowMs);
      samples.generatorUtilization.push(generatorCpuMs / (pass.windowMs * generatorCpus));
      samples.errors.merge(pass.errors);
      samples.requests += pass.measured;
      await proc.stop(subject.bootTimeoutMs);
    });
    this.removeTraceFile(subject);

    if (workload.rate === undefined) return;
    const rate = workload.rate;
    const latencyWhere = { round, label: `latency pass of ${workload.name}` };
    await this.withBoot(subject, latencyWhere, async (proc) => {
      await proc.untilReady(subject.readinessUrl!, subject.bootTimeoutMs);
      await sleep(RSS_SETTLE_MS, this.host.signal);
      const idle = sampleTree(proc.pid, ticks).rssBytes;
      let peak = idle;
      let samplerError: unknown;
      const sampler = setInterval(() => {
        try {
          peak = Math.max(peak, sampleTree(proc.pid, ticks).rssBytes);
        } catch (error) {
          samplerError = error;
          clearInterval(sampler);
        }
      }, RSS_SAMPLE_MS);
      let subjectCpuAtOpen = 0;
      let subjectCpuMs = 0;
      let pass;
      try {
        pass = await runLoadPass({
          mode: "rate",
          requests: workload.requests,
          weights: workload.weights,
          concurrency: workload.concurrency,
          rate,
          warmupMs: workload.warmupMs,
          durationMs: workload.durationMs,
          generatorCpus,
          signal: this.host.signal,
          onWindow: (edge) => {
            if (edge === "open") subjectCpuAtOpen = sampleTree(proc.pid, ticks).cpuMs;
            else if (edge === "drained") subjectCpuMs = sampleTree(proc.pid, ticks).cpuMs - subjectCpuAtOpen;
          },
        });
      } finally {
        clearInterval(sampler);
      }
      if (samplerError !== undefined) throw samplerError;
      peak = Math.max(peak, sampleTree(proc.pid, ticks).rssBytes);
      await sleep(RSS_SETTLE_MS, this.host.signal);
      const after = sampleTree(proc.pid, ticks).rssBytes;
      this.assertRunning(subject, latencyWhere, proc);
      samples.p50Ms.push(pass.latency.percentileMs(0.5));
      samples.p99Ms.push(pass.latency.percentileMs(0.99));
      samples.cpuPerRequestMs.push(pass.measured > 0 ? subjectCpuMs / pass.measured : 0);
      samples.rssIdle.push(idle);
      samples.rssPeak.push(peak);
      samples.rssAfter.push(after);
      samples.errors.merge(pass.errors);
      samples.requests += pass.measured;
      await proc.stop(subject.bootTimeoutMs);
    });
    this.removeTraceFile(subject);
  }

  private assertRunning(subject: SubjectSettings, where: Where, proc: SubjectProcess): void {
    const fault = proc.exitFault();
    if (fault) throw this.bootFailure(subject, where, fault, "load");
  }

  private removeTraceFile(subject: SubjectSettings): void {
    if (subject.traceFile) rmSync(resolve(subject.cwd, subject.traceFile), { force: true });
  }
}

function samplesFor<T>(map: Map<string, T>, key: string, make: () => T): T {
  let value = map.get(key);
  if (!value) {
    value = make();
    map.set(key, value);
  }
  return value;
}
