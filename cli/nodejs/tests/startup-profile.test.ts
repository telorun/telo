import { describe, expect, it } from "vitest";
import { StartupProfiler } from "../src/startup-profile.js";

describe("StartupProfiler", () => {
  it("reports completed phases and a monotonic startup duration", () => {
    const ticks = [0n, 1_000_000n, 4_000_000n, 10_000_000n, 15_000_000n, 20_000_000n];
    const profiler = new StartupProfiler(() => ticks.shift()!);

    profiler.start("load");
    profiler.end("load");
    profiler.start("kernelPreparation");
    profiler.end("kernelPreparation");

    expect(profiler.report("started")).toEqual({
      version: 1,
      outcome: "started",
      startupMs: 20,
      phasesMs: { load: 3, kernelPreparation: 5 },
      resources: [],
    });
  });

  it("reports the partial duration of the phase that failed", () => {
    const ticks = [0n, 2_000_000n, 3_000_000n];
    const profiler = new StartupProfiler(() => ticks.shift()!);

    profiler.start("load");

    expect(profiler.report("failed", "load")).toEqual({
      version: 1,
      outcome: "failed",
      startupMs: 3,
      phasesMs: { load: 1 },
      resources: [],
      failurePhase: "load",
    });
  });

  it("includes the partial duration of a phase interrupted by failure", () => {
    const ticks = [0n, 2_000_000n, 9_000_000n];
    const profiler = new StartupProfiler(() => ticks.shift()!);

    profiler.start("resourceInitialization");

    expect(profiler.report("failed", "resourceInitialization")).toEqual({
      version: 1,
      outcome: "failed",
      startupMs: 9,
      phasesMs: { resourceInitialization: 7 },
      resources: [],
      failurePhase: "resourceInitialization",
    });
  });

  it("sorts resources by total create and initialization work, leaving out aggregates", () => {
    const profiler = new StartupProfiler(() => 0n);
    profiler.recordResourceInitialization({
      resource: { id: "Telo.Import.Sql", kind: "Telo.Import", name: "Sql" },
      durationMs: 100,
      outcome: "initialized",
      aggregate: true,
    });
    profiler.recordResourceCreate({
      resource: { id: "fast", kind: "Config.Value", name: "settings" },
      durationMs: 2,
      outcome: "created",
    });
    profiler.recordResourceInitialization({
      resource: { id: "slow", kind: "Sql.Connection", name: "database" },
      durationMs: 20,
      outcome: "deferred",
    });
    profiler.recordResourceInitialization({
      resource: { id: "slow", kind: "Sql.Connection", name: "database" },
      durationMs: 30,
      outcome: "initialized",
    });

    expect(profiler.report("started").resources).toEqual([
      {
        id: "slow",
        kind: "Sql.Connection",
        name: "database",
        createMs: 0,
        initializationMs: 50,
        totalMs: 50,
        createAttempts: 0,
        initializationAttempts: 2,
        deferredInitializationAttempts: 1,
        failedInitializationAttempts: 0,
      },
      {
        id: "fast",
        kind: "Config.Value",
        name: "settings",
        createMs: 2,
        initializationMs: 0,
        totalMs: 2,
        createAttempts: 1,
        initializationAttempts: 0,
        deferredInitializationAttempts: 0,
        failedInitializationAttempts: 0,
      },
    ]);
  });
});