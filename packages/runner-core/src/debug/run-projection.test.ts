import { describe, expect, it } from "vitest";

import type { DebugFrame } from "@telorun/debug-wire";
import type { RunEvent } from "../contract.js";
import { SessionRegistry } from "../session/registry.js";
import { RunProjection } from "./run-projection.js";

function harness(apps = [{ name: "app" }]) {
  const registry = new SessionRegistry({
    maxSessions: 4,
    exitTtlMs: 1000,
    replayBufferBytes: 100_000,
  });
  const entry = registry.register({ sessionId: "s1", mode: "watch", apps });
  const projection = new RunProjection(registry, "s1");
  entry.attribution = projection;
  const runs = (): RunEvent[] =>
    entry.buffer.replay(0).entries.map((e) => e.event).filter((e) => e.type === "run");
  return { registry, entry, projection, runs };
}

const event = (name: string, payload?: unknown): DebugFrame => ({
  kind: "event",
  timestamp: "2026-01-01T00:00:00.000Z",
  event: name,
  payload,
});

describe("RunProjection", () => {
  it("brackets a generation from Kernel.Starting and Kernel.Stopped", () => {
    const h = harness();
    h.projection.expectAll("initial");
    h.projection.frame("app", event("Kernel.Starting"));
    h.projection.frame("app", event("Kernel.Started"));
    h.projection.frame("app", event("Kernel.Stopped", { exitCode: 0 }));

    expect(h.runs()).toMatchObject([
      { type: "run", app: "app", generation: 1, phase: "started", trigger: "initial" },
      { type: "run", app: "app", generation: 1, phase: "completed", code: 0 },
    ]);
  });

  it("leaves the session running when a generation completes", () => {
    const h = harness();
    h.projection.expectAll("initial");
    h.registry.emit("s1", { type: "status", status: { kind: "running" } });
    h.projection.frame("app", event("Kernel.Starting"));
    h.projection.frame("app", event("Kernel.Stopped", { exitCode: 0 }));

    // The whole point of the split: a one-shot app finishing is not the session
    // ending, so nothing is scheduled for eviction.
    expect(h.entry.status).toEqual({ kind: "running" });
    expect(h.entry.exitedAt).toBeNull();
    expect(h.entry.evictionTimer).toBeNull();
  });

  it("counts a reload as the next generation and attributes it to the watcher", () => {
    const h = harness();
    h.projection.expectAll("initial");
    h.projection.frame("app", event("Kernel.Starting"));
    h.projection.frame("app", event("Kernel.Stopped", { exitCode: 0 }));
    h.projection.frame("app", event("Kernel.Starting"));

    expect(h.runs().at(-1)).toMatchObject({
      generation: 2,
      phase: "started",
      trigger: "watch",
    });
  });

  it("attributes a generation a route caused, then falls back to watch", () => {
    const h = harness();
    h.projection.expectAll("initial");
    h.projection.frame("app", event("Kernel.Starting"));
    h.projection.frame("app", event("Kernel.Stopped", { exitCode: 0 }));

    h.projection.expect("app", "manual");
    h.projection.frame("app", event("Kernel.Starting"));
    h.projection.frame("app", event("Kernel.Stopped", { exitCode: 0 }));
    h.projection.frame("app", event("Kernel.Starting"));

    const started = h.runs().filter((e) => e.type === "run" && e.phase === "started");
    expect(started.map((e) => (e as { trigger: string }).trigger)).toEqual([
      "initial",
      "manual",
      "watch",
    ]);
  });

  it("opens a generation for a load failure, which emits no Kernel.Starting", () => {
    const h = harness();
    h.projection.expectAll("initial");
    // A manifest that fails to LOAD never reaches Kernel.Starting; reporting the
    // failure of a generation the client never saw start would be unreadable.
    h.projection.frame(
      "app",
      event("Kernel.RunFailed", {
        phase: "load",
        code: "ERR_MANIFEST_VALIDATION_FAILED",
        message: "bad manifest",
      }),
    );

    expect(h.runs()).toMatchObject([
      { generation: 1, phase: "started", trigger: "initial" },
      { generation: 1, phase: "failed", reason: "ERR_MANIFEST_VALIDATION_FAILED" },
    ]);
  });

  it("does not double-count a boot failure that follows Kernel.Starting", () => {
    const h = harness();
    h.projection.expectAll("initial");
    h.projection.frame("app", event("Kernel.Starting"));
    h.projection.frame("app", event("Kernel.RunFailed", { phase: "start", message: "boom" }));

    expect(h.runs()).toMatchObject([
      { generation: 1, phase: "started" },
      { generation: 1, phase: "failed", reason: "boom" },
    ]);
  });

  it("closes a generation whose WORKLOAD ended, with no Kernel.Stopped", () => {
    const h = harness();
    h.projection.expectAll("initial");
    h.projection.frame("app", event("Kernel.Starting"));
    // A container that goes away emits nothing — there is nothing left to emit
    // it — so the backend reports the ending through the contract instead.
    h.projection.endGeneration("app", { reason: "application container exited" });

    expect(h.runs()).toMatchObject([
      { generation: 1, phase: "started" },
      { generation: 1, phase: "failed", reason: "application container exited" },
    ]);
  });

  it("ignores a workload ending when no generation is open", () => {
    const h = harness();
    h.projection.endGeneration("app", { reason: "gone" });
    expect(h.runs()).toEqual([]);
  });

  it("counts generations per app, not per session", () => {
    const h = harness([{ name: "web" }, { name: "worker" }]);
    h.projection.expectAll("initial");
    h.projection.frame("web", event("Kernel.Starting"));
    h.projection.frame("worker", event("Kernel.Starting"));
    h.projection.frame("worker", event("Kernel.Stopped", { exitCode: 0 }));
    h.projection.frame("worker", event("Kernel.Starting"));

    const byApp = (name: string) =>
      h.runs().filter((e) => (e as { app: string }).app === name);
    expect(byApp("web").at(-1)).toMatchObject({ generation: 1, phase: "started" });
    expect(byApp("worker").at(-1)).toMatchObject({ generation: 2, phase: "started" });
  });
});
