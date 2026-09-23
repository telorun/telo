import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

const PROFILE_VERSION = 2;

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
  /** How much of `resourceInitialization` the timed work below accounts for. */
  attribution?: StartupAttribution;
  resources: StartupResourceProfile[];
  /** `Telo.Import`s, whose windows contain their library's resources. */
  imports: StartupResourceProfile[];
  memory?: StartupMemoryProfile;
  failurePhase?: string;
}

/** Process memory, in bytes. One heap is shared by everything the process runs,
 *  so these are readings of the process, never of a resource. */
export interface StartupMemoryProfile {
  /** Change across each phase: `heap` is heap plus off-heap (`external`) memory in
   *  use, `rss` the resident set. A collection inside a phase shrinks it. */
  phases: Partial<Record<StartupPhase, { heapDeltaBytes: number; rssDeltaBytes: number }>>;
  /** Readings when the report was taken. */
  atReport: MemoryReading;
  /** The largest resident set the process has had, from the operating system. */
  peakRssBytes: number;
}

export interface MemoryReading {
  rssBytes: number;
  heapTotalBytes: number;
  heapUsedBytes: number;
  /** Memory held outside the JavaScript heap, array buffers included. */
  externalBytes: number;
  arrayBuffersBytes: number;
}

export interface MemorySource {
  usage(): NodeJS.MemoryUsage;
  /** Peak resident set, in bytes. */
  peakRss(): number;
}

const processMemory: MemorySource = {
  usage: () => process.memoryUsage(),
  // `maxRSS` is in kilobytes.
  peakRss: () => process.resourceUsage().maxRSS * 1024,
};

export interface StartupAttribution {
  resourceInitializationMs: number;
  /** Sum of every timed window's own time — each millisecond counted once. */
  attributedMs: number;
  /** Loop bookkeeping and anything else no timed window covers. */
  unattributedMs: number;
}

export interface StartupResourceProfile {
  id: string;
  kind: string;
  name: string;
  module?: string;
  createMs: number;
  initializationMs: number;
  totalMs: number;
  /** `totalMs` minus the windows of other resources nested inside it (a
   *  template's children, an import's library). */
  selfMs: number;
  createAttempts: number;
  initializationAttempts: number;
  deferredInitializationAttempts: number;
  failedInitializationAttempts: number;
  /** Change in heap plus off-heap memory in use across the create windows —
   *  what they allocated minus what the collector freed meanwhile, so a
   *  collection inside a window makes it small or negative. Present when the
   *  kernel reports memory. */
  createHeapDeltaBytes?: number;
  initializationHeapDeltaBytes?: number;
  heapDeltaBytes?: number;
  /** `heapDeltaBytes` minus the windows of resources nested inside it, the
   *  counterpart of `selfMs`: the closest reading of a resource's own memory. */
  selfHeapDeltaBytes?: number;
}

type ResourceTimingPayload = {
  resource?: { id?: unknown; kind?: unknown; name?: unknown; module?: unknown };
  startedAtMs?: unknown;
  durationMs?: unknown;
  heapDeltaBytes?: unknown;
  outcome?: unknown;
  aggregate?: unknown;
};

type ResourceTiming = Omit<
  StartupResourceProfile,
  "totalMs" | "selfMs" | "heapDeltaBytes" | "selfHeapDeltaBytes"
>;

interface TimedWindow {
  row: ResourceTiming;
  startMs: number;
  endMs: number;
  heapDeltaBytes: number | undefined;
  phase: StartupPhase | undefined;
}

interface SelfReading {
  ms: number;
  heapDeltaBytes: number | undefined;
}

/** Records CLI-visible startup phases without enabling tracing or debug sinks. */
export class StartupProfiler {
  private readonly startedAt: bigint;
  /** Running phases in the order they started, so the last is the innermost. */
  private readonly starts = new Map<StartupPhase, bigint>();
  private readonly durations = new Map<StartupPhase, number>();
  private readonly memoryAtStart = new Map<StartupPhase, NodeJS.MemoryUsage>();
  private readonly memoryDeltas = new Map<
    StartupPhase,
    { heapDeltaBytes: number; rssDeltaBytes: number }
  >();
  private readonly resources = new Map<string, ResourceTiming>();
  private readonly imports = new Map<string, ResourceTiming>();
  private readonly windows: TimedWindow[] = [];

  constructor(
    private readonly now: () => bigint = process.hrtime.bigint,
    private readonly memory: MemorySource = processMemory,
  ) {
    this.startedAt = now();
  }

  start(phase: StartupPhase): void {
    this.starts.delete(phase);
    this.starts.set(phase, this.now());
    this.memoryAtStart.set(phase, this.memory.usage());
  }

  end(phase: StartupPhase): void {
    const started = this.starts.get(phase);
    if (started === undefined) return;
    this.durations.set(phase, elapsedMs(started, this.now()));
    this.starts.delete(phase);
    this.recordPhaseMemory(phase, this.memory.usage());
  }

  recordResourceCreate(payload: ResourceTimingPayload): void {
    const row = this.record(payload);
    if (!row) return;
    row.createAttempts++;
    row.createMs += payload.durationMs as number;
    if (isFiniteNumber(payload.heapDeltaBytes)) {
      row.createHeapDeltaBytes = (row.createHeapDeltaBytes ?? 0) + payload.heapDeltaBytes;
    }
  }

  recordResourceInitialization(payload: ResourceTimingPayload): void {
    const row = this.record(payload);
    if (!row) return;
    row.initializationAttempts++;
    row.initializationMs += payload.durationMs as number;
    if (isFiniteNumber(payload.heapDeltaBytes)) {
      row.initializationHeapDeltaBytes =
        (row.initializationHeapDeltaBytes ?? 0) + payload.heapDeltaBytes;
    }
    if (payload.outcome === "deferred") row.deferredInitializationAttempts++;
    if (payload.outcome === "failed") row.failedInitializationAttempts++;
  }

  report(outcome: StartupProfileReport["outcome"], failurePhase?: string): StartupProfileReport {
    const endedAt = this.now();
    const usage = this.memory.usage();
    const phasesMs: Partial<Record<StartupPhase, number>> = {};
    const phaseMemory: StartupMemoryProfile["phases"] = {};
    for (const phase of PHASES) {
      const duration = this.durations.get(phase) ?? activeDuration(this.starts.get(phase), endedAt);
      if (duration !== undefined) phasesMs[phase] = duration;
      // A phase still running — the one a failure interrupted — is read to now.
      if (this.starts.has(phase)) this.recordPhaseMemory(phase, usage);
      const delta = this.memoryDeltas.get(phase);
      if (delta) phaseMemory[phase] = delta;
    }
    const self = selfReadings(this.windows);
    const initializationMs = phasesMs.resourceInitialization;
    let attributedMs = 0;
    for (const [window, reading] of self) {
      if (window.phase === "resourceInitialization") attributedMs += reading.ms;
    }
    return {
      version: PROFILE_VERSION,
      outcome,
      startupMs: elapsedMs(this.startedAt, endedAt),
      phasesMs,
      ...(initializationMs === undefined
        ? {}
        : {
            attribution: {
              resourceInitializationMs: initializationMs,
              attributedMs,
              unattributedMs: initializationMs - attributedMs,
            },
          }),
      resources: rows(this.resources, self),
      imports: rows(this.imports, self),
      memory: {
        phases: phaseMemory,
        atReport: {
          rssBytes: usage.rss,
          heapTotalBytes: usage.heapTotal,
          heapUsedBytes: usage.heapUsed,
          externalBytes: usage.external,
          arrayBuffersBytes: usage.arrayBuffers,
        },
        peakRssBytes: this.memory.peakRss(),
      },
      ...(failurePhase === undefined ? {} : { failurePhase }),
    };
  }

  private recordPhaseMemory(phase: StartupPhase, ended: NodeJS.MemoryUsage): void {
    const started = this.memoryAtStart.get(phase);
    if (!started) return;
    this.memoryDeltas.set(phase, {
      heapDeltaBytes: ended.heapUsed + ended.external - (started.heapUsed + started.external),
      rssDeltaBytes: ended.rss - started.rss,
    });
  }

  private record(payload: ResourceTimingPayload): ResourceTiming | undefined {
    const descriptor = payload.resource;
    if (
      !descriptor ||
      typeof descriptor.id !== "string" ||
      typeof descriptor.kind !== "string" ||
      typeof descriptor.name !== "string" ||
      !isFiniteNumber(payload.startedAtMs) ||
      !isFiniteNumber(payload.durationMs)
    ) {
      return undefined;
    }
    // An import's window contains its library's resources, which report their
    // own timings; it is listed apart so the resource rows never count one
    // millisecond twice.
    const table = payload.aggregate === true ? this.imports : this.resources;
    let row = table.get(descriptor.id);
    if (!row) {
      row = {
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
      table.set(descriptor.id, row);
    }
    this.windows.push({
      row,
      startMs: payload.startedAtMs,
      endMs: payload.startedAtMs + payload.durationMs,
      heapDeltaBytes: isFiniteNumber(payload.heapDeltaBytes) ? payload.heapDeltaBytes : undefined,
      phase: this.activePhase(),
    });
    return row;
  }

  private activePhase(): StartupPhase | undefined {
    let innermost: StartupPhase | undefined;
    for (const phase of this.starts.keys()) innermost = phase;
    return innermost;
  }
}

/**
 * Each window's own time and memory: its reading minus the windows directly
 * nested in it.
 *
 * The init loop awaits one resource at a time per context, and a nested context
 * (an import's library, a template's children) runs inside the window of the
 * resource that owns it — so windows nest rather than interleave, and a window
 * that starts inside another and ends within it is its child.
 */
function selfReadings(windows: readonly TimedWindow[]): Map<TimedWindow, SelfReading> {
  const ordered = [...windows].sort((a, b) => a.startMs - b.startMs || b.endMs - a.endMs);
  const self = new Map<TimedWindow, SelfReading>();
  const stack: TimedWindow[] = [];
  for (const window of ordered) {
    while (stack.length > 0 && stack[stack.length - 1]!.endMs <= window.startMs) stack.pop();
    const parent = stack[stack.length - 1];
    self.set(window, { ms: window.endMs - window.startMs, heapDeltaBytes: window.heapDeltaBytes });
    if (parent && window.endMs <= parent.endMs) {
      const own = self.get(parent)!;
      own.ms -= window.endMs - window.startMs;
      if (own.heapDeltaBytes !== undefined && window.heapDeltaBytes !== undefined) {
        own.heapDeltaBytes -= window.heapDeltaBytes;
      }
    }
    stack.push(window);
  }
  return self;
}

function rows(
  table: ReadonlyMap<string, ResourceTiming>,
  self: ReadonlyMap<TimedWindow, SelfReading>,
): StartupResourceProfile[] {
  const selfByRow = new Map<ResourceTiming, SelfReading>();
  for (const [window, reading] of self) {
    const total = selfByRow.get(window.row);
    if (!total) {
      selfByRow.set(window.row, { ...reading });
      continue;
    }
    total.ms += reading.ms;
    if (reading.heapDeltaBytes !== undefined) {
      total.heapDeltaBytes = (total.heapDeltaBytes ?? 0) + reading.heapDeltaBytes;
    }
  }
  return [...table.values()]
    .map((row) => {
      const own = selfByRow.get(row);
      const measured =
        row.createHeapDeltaBytes !== undefined || row.initializationHeapDeltaBytes !== undefined;
      return {
        ...row,
        totalMs: row.createMs + row.initializationMs,
        selfMs: own?.ms ?? 0,
        ...(measured
          ? {
              heapDeltaBytes: (row.createHeapDeltaBytes ?? 0) + (row.initializationHeapDeltaBytes ?? 0),
              selfHeapDeltaBytes: own?.heapDeltaBytes ?? 0,
            }
          : {}),
      };
    })
    .sort((left, right) => right.selfMs - left.selfMs);
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function elapsedMs(started: bigint, ended: bigint): number {
  return Number(ended - started) / 1_000_000;
}

function activeDuration(started: bigint | undefined, ended: bigint): number | undefined {
  return started === undefined ? undefined : elapsedMs(started, ended);
}
