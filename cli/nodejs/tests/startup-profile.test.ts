import { describe, expect, it } from "vitest";
import { StartupProfiler, type MemorySource } from "../src/startup-profile.js";

const MB = 1024 * 1024;

/** Each `usage()` reads the next heap size in MB; the resident set is twice it. */
function memoryReadings(...heapMb: number[]): MemorySource {
  return {
    usage: () => {
      const mb = heapMb.shift()!;
      return { rss: 2 * mb * MB, heapTotal: 100 * MB, heapUsed: mb * MB, external: MB, arrayBuffers: 0 };
    },
    peakRss: () => 500 * MB,
  };
}

const atReport = (heapMb: number) => ({
  rssBytes: 2 * heapMb * MB,
  heapTotalBytes: 100 * MB,
  heapUsedBytes: heapMb * MB,
  externalBytes: MB,
  arrayBuffersBytes: 0,
});

describe("StartupProfiler", () => {
  it("reports completed phases and a monotonic startup duration", () => {
    const ticks = [0n, 1_000_000n, 4_000_000n, 10_000_000n, 15_000_000n, 20_000_000n];
    const profiler = new StartupProfiler(() => ticks.shift()!, memoryReadings(10, 14, 14, 15, 16));

    profiler.start("load");
    profiler.end("load");
    profiler.start("kernelPreparation");
    profiler.end("kernelPreparation");

    expect(profiler.report("started")).toEqual({
      version: 2,
      outcome: "started",
      startupMs: 20,
      phasesMs: { load: 3, kernelPreparation: 5 },
      resources: [],
      imports: [],
      memory: {
        phases: {
          load: { heapDeltaBytes: 4 * MB, rssDeltaBytes: 8 * MB },
          kernelPreparation: { heapDeltaBytes: MB, rssDeltaBytes: 2 * MB },
        },
        atReport: atReport(16),
        peakRssBytes: 500 * MB,
      },
    });
  });

  it("reports the partial duration of the phase that failed", () => {
    const ticks = [0n, 2_000_000n, 3_000_000n];
    const profiler = new StartupProfiler(() => ticks.shift()!, memoryReadings(10, 13));

    profiler.start("load");

    expect(profiler.report("failed", "load")).toEqual({
      version: 2,
      outcome: "failed",
      startupMs: 3,
      phasesMs: { load: 1 },
      resources: [],
      imports: [],
      memory: {
        phases: { load: { heapDeltaBytes: 3 * MB, rssDeltaBytes: 6 * MB } },
        atReport: atReport(13),
        peakRssBytes: 500 * MB,
      },
      failurePhase: "load",
    });
  });

  it("includes the partial duration of a phase interrupted by failure", () => {
    const ticks = [0n, 2_000_000n, 9_000_000n];
    const profiler = new StartupProfiler(() => ticks.shift()!, memoryReadings(10, 12));

    profiler.start("resourceInitialization");

    expect(profiler.report("failed", "resourceInitialization")).toEqual({
      version: 2,
      outcome: "failed",
      startupMs: 9,
      phasesMs: { resourceInitialization: 7 },
      attribution: { resourceInitializationMs: 7, attributedMs: 0, unattributedMs: 7 },
      resources: [],
      imports: [],
      memory: {
        phases: { resourceInitialization: { heapDeltaBytes: 2 * MB, rssDeltaBytes: 4 * MB } },
        atReport: atReport(12),
        peakRssBytes: 500 * MB,
      },
      failurePhase: "resourceInitialization",
    });
  });

  it("lists imports apart from resources and reports each row's own time", () => {
    const ticks = [0n, 0n, 200_000_000n, 200_000_000n];
    const profiler = new StartupProfiler(() => ticks.shift()!);
    profiler.start("resourceInitialization");

    // An import whose 100ms window holds its library's connection (20ms
    // deferred, then 30ms), and a template whose init holds a child's create.
    profiler.recordResourceInitialization({
      resource: { id: "slow", kind: "Sql.Connection", name: "database" },
      startedAtMs: 10,
      durationMs: 20,
      outcome: "deferred",
    });
    profiler.recordResourceInitialization({
      resource: { id: "slow", kind: "Sql.Connection", name: "database" },
      startedAtMs: 40,
      durationMs: 30,
      outcome: "initialized",
    });
    profiler.recordResourceInitialization({
      resource: { id: "Telo.Import.Sql", kind: "Telo.Import", name: "Sql" },
      startedAtMs: 0,
      durationMs: 100,
      outcome: "initialized",
      aggregate: true,
    });
    profiler.recordResourceCreate({
      resource: { id: "child", kind: "Http.Request", name: "req" },
      startedAtMs: 125,
      durationMs: 60,
      outcome: "created",
    });
    profiler.recordResourceInitialization({
      resource: { id: "parent", kind: "Api.Call", name: "call" },
      startedAtMs: 120,
      durationMs: 70,
      outcome: "initialized",
    });
    profiler.end("resourceInitialization");

    const report = profiler.report("started");
    expect(report.attribution).toEqual({
      resourceInitializationMs: 200,
      attributedMs: 170,
      unattributedMs: 30,
    });
    expect(report.imports).toEqual([
      {
        id: "Telo.Import.Sql",
        kind: "Telo.Import",
        name: "Sql",
        createMs: 0,
        initializationMs: 100,
        totalMs: 100,
        selfMs: 50,
        createAttempts: 0,
        initializationAttempts: 1,
        deferredInitializationAttempts: 0,
        failedInitializationAttempts: 0,
      },
    ]);
    expect(report.resources.map((r) => [r.id, r.totalMs, r.selfMs])).toEqual([
      ["child", 60, 60],
      ["slow", 50, 50],
      ["parent", 70, 10],
    ]);
    expect(report.resources.find((r) => r.id === "slow")).toMatchObject({
      initializationAttempts: 2,
      deferredInitializationAttempts: 1,
    });
  });

  it("reports each row's memory, and its own apart from what nests inside it", () => {
    const profiler = new StartupProfiler(() => 0n, memoryReadings(10, 10, 10));
    profiler.start("resourceInitialization");
    // A template whose init window holds its child's create, both reporting memory.
    profiler.recordResourceCreate({
      resource: { id: "child", kind: "Http.Request", name: "req" },
      startedAtMs: 5,
      durationMs: 10,
      heapDeltaBytes: 3000,
      outcome: "created",
    });
    profiler.recordResourceCreate({
      resource: { id: "parent", kind: "Api.Call", name: "call" },
      startedAtMs: 0,
      durationMs: 2,
      heapDeltaBytes: 500,
      outcome: "created",
    });
    profiler.recordResourceInitialization({
      resource: { id: "parent", kind: "Api.Call", name: "call" },
      startedAtMs: 3,
      durationMs: 20,
      heapDeltaBytes: 4000,
      outcome: "initialized",
    });
    // A kernel that reports no memory leaves the row without memory fields.
    profiler.recordResourceCreate({
      resource: { id: "quiet", kind: "Run.Value", name: "v" },
      startedAtMs: 30,
      durationMs: 1,
      outcome: "created",
    });
    profiler.end("resourceInitialization");

    const byId = Object.fromEntries(profiler.report("started").resources.map((r) => [r.id, r]));
    expect(byId.parent).toMatchObject({
      createHeapDeltaBytes: 500,
      initializationHeapDeltaBytes: 4000,
      heapDeltaBytes: 4500,
      selfHeapDeltaBytes: 1500,
    });
    expect(byId.child).toMatchObject({ heapDeltaBytes: 3000, selfHeapDeltaBytes: 3000 });
    expect(byId.quiet).not.toHaveProperty("heapDeltaBytes");
    expect(byId.quiet).not.toHaveProperty("selfHeapDeltaBytes");
  });

  it("attributes a window to the innermost running phase", () => {
    const ticks = [0n, 0n, 0n, 100_000_000n, 100_000_000n, 100_000_000n];
    const profiler = new StartupProfiler(() => ticks.shift()!);
    profiler.start("load");
    profiler.start("resourceInitialization");
    profiler.recordResourceCreate({
      resource: { id: "x", kind: "Config.Value", name: "settings" },
      startedAtMs: 10,
      durationMs: 40,
      outcome: "created",
    });
    profiler.end("resourceInitialization");
    profiler.end("load");

    expect(profiler.report("started").attribution).toEqual({
      resourceInitializationMs: 100,
      attributedMs: 40,
      unattributedMs: 60,
    });
  });

  it("ignores a timing event without a start", () => {
    const profiler = new StartupProfiler(() => 0n);
    profiler.recordResourceCreate({
      resource: { id: "x", kind: "Config.Value", name: "settings" },
      durationMs: 2,
      outcome: "created",
    });
    expect(profiler.report("started").resources).toEqual([]);
  });
});
