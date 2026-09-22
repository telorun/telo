import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

const PROFILE_VERSION = 1;

const PHASES = [
  "kernelCreate",
  "envFiles",
  "load",
  "manifestCachePersist",
  "kernelPreparation",
  "resourceInitialization",
  "targets",
] as const;

type StartupPhase = (typeof PHASES)[number];

export interface StartupProfileReport {
  version: number;
  outcome: "started" | "failed";
  startupMs: number;
  phasesMs: Partial<Record<StartupPhase, number>>;
  resources: StartupResourceProfile[];
  failurePhase?: string;
}

export interface StartupResourceProfile {
  id: string;
  kind: string;
  name: string;
  module?: string;
  createMs: number;
  initializationMs: number;
  totalMs: number;
  createAttempts: number;
  initializationAttempts: number;
  deferredInitializationAttempts: number;
  failedInitializationAttempts: number;
}

type ResourceTimingPayload = {
  resource?: { id?: unknown; kind?: unknown; name?: unknown; module?: unknown };
  durationMs?: unknown;
  outcome?: unknown;
  aggregate?: unknown;
};

type ResourceTiming = Omit<StartupResourceProfile, "totalMs">;

/** Records CLI-visible startup phases without enabling tracing or debug sinks. */
export class StartupProfiler {
  private readonly startedAt: bigint;
  private readonly starts = new Map<StartupPhase, bigint>();
  private readonly durations = new Map<StartupPhase, number>();
  private readonly resources = new Map<string, ResourceTiming>();

  constructor(private readonly now: () => bigint = process.hrtime.bigint) {
    this.startedAt = now();
  }

  start(phase: StartupPhase): void {
    this.starts.set(phase, this.now());
  }

  end(phase: StartupPhase): void {
    const started = this.starts.get(phase);
    if (started === undefined) return;
    this.durations.set(phase, elapsedMs(started, this.now()));
    this.starts.delete(phase);
  }

  recordResourceCreate(payload: ResourceTimingPayload): void {
    const resource = this.resourceFor(payload);
    if (!resource) return;
    resource.createAttempts++;
    resource.createMs += payload.durationMs as number;
  }

  recordResourceInitialization(payload: ResourceTimingPayload): void {
    const resource = this.resourceFor(payload);
    if (!resource) return;
    resource.initializationAttempts++;
    resource.initializationMs += payload.durationMs as number;
    if (payload.outcome === "deferred") resource.deferredInitializationAttempts++;
    if (payload.outcome === "failed") resource.failedInitializationAttempts++;
  }

  report(outcome: StartupProfileReport["outcome"], failurePhase?: string): StartupProfileReport {
    const endedAt = this.now();
    const phasesMs: Partial<Record<StartupPhase, number>> = {};
    for (const phase of PHASES) {
      const duration = this.durations.get(phase) ?? activeDuration(this.starts.get(phase), endedAt);
      if (duration !== undefined) phasesMs[phase] = duration;
    }
    return {
      version: PROFILE_VERSION,
      outcome,
      startupMs: elapsedMs(this.startedAt, endedAt),
      phasesMs,
      resources: [...this.resources.values()]
        .map((resource) => ({
          ...resource,
          totalMs: resource.createMs + resource.initializationMs,
        }))
        .sort((left, right) => right.totalMs - left.totalMs),
      ...(failurePhase === undefined ? {} : { failurePhase }),
    };
  }

  private resourceFor(payload: ResourceTimingPayload): ResourceTiming | undefined {
    const descriptor = payload.resource;
    if (
      !descriptor ||
      typeof descriptor.id !== "string" ||
      typeof descriptor.kind !== "string" ||
      typeof descriptor.name !== "string" ||
      typeof payload.durationMs !== "number" ||
      !Number.isFinite(payload.durationMs)
    ) {
      return undefined;
    }
    // Its duration contains other resources' timings, which are reported too.
    if (payload.aggregate === true) return undefined;
    let timing = this.resources.get(descriptor.id);
    if (!timing) {
      timing = {
        id: descriptor.id,
        kind: descriptor.kind,
        name: descriptor.name,
        ...(typeof descriptor.module === "string" ? { module: descriptor.module } : {}),
        createMs: 0,
        initializationMs: 0,
        createAttempts: 0,
        initializationAttempts: 0,
        deferredInitializationAttempts: 0,
        failedInitializationAttempts: 0,
      };
      this.resources.set(descriptor.id, timing);
    }
    return timing;
  }
}

export async function writeStartupProfile(
  destination: string,
  report: StartupProfileReport,
): Promise<void> {
  const absolute = path.resolve(destination);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.rename(temporary, absolute);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

function elapsedMs(started: bigint, ended: bigint): number {
  return Number(ended - started) / 1_000_000;
}

function activeDuration(started: bigint | undefined, ended: bigint): number | undefined {
  return started === undefined ? undefined : elapsedMs(started, ended);
}