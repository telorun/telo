import { describe, expect, it, vi } from "vitest";

import { SessionRegistry, type SessionEntry } from "./registry.js";
import { WatchSupervisor } from "./watch-supervisor.js";

function makeRegistry() {
  return new SessionRegistry({
    maxSessions: 4,
    exitTtlMs: 60_000,
    replayBufferBytes: 100_000,
    suspendedTtlMs: 3_600_000,
  });
}

describe("suspended is not terminal", () => {
  it("keeps the session and schedules its own eviction, not the exit one", () => {
    const registry = makeRegistry();
    const entry = registry.register({ sessionId: "s1", mode: "watch" });
    registry.emit("s1", { type: "status", status: { kind: "suspended" } });

    expect(registry.has("s1")).toBe(true);
    // `exitedAt` is what marks a session terminal for capacity eviction — a
    // suspended session must not be a candidate.
    expect(entry.exitedAt).toBeNull();
    expect(entry.evictionTimer).not.toBeNull();
  });

  it("cancels the suspended eviction when the session resumes", () => {
    const registry = makeRegistry();
    const entry = registry.register({ sessionId: "s1", mode: "watch" });
    registry.emit("s1", { type: "status", status: { kind: "suspended" } });
    registry.emit("s1", { type: "status", status: { kind: "running" } });

    expect(entry.evictionTimer).toBeNull();
  });
});

describe("a suspended session does not hold a slot", () => {
  it("is evicted to make room rather than blocking a new session", () => {
    // Losing it costs exactly what a runner restart already costs — a checkpoint
    // the editor re-seeds. Excluding it would let a handful of visitors who each
    // left after five minutes hold every slot for the whole suspended TTL.
    const registry = new SessionRegistry({
      maxSessions: 1,
      exitTtlMs: 60_000,
      replayBufferBytes: 100_000,
      suspendedTtlMs: 86_400_000,
    });
    registry.register({ sessionId: "old", mode: "watch" });
    registry.emit("old", { type: "status", status: { kind: "suspended" } });

    expect(() => registry.register({ sessionId: "new", mode: "watch" })).not.toThrow();
    expect(registry.has("old")).toBe(false);
    expect(registry.has("new")).toBe(true);
  });

  it("never evicts a live session to make room", () => {
    const registry = new SessionRegistry({
      maxSessions: 1,
      exitTtlMs: 60_000,
      replayBufferBytes: 100_000,
    });
    registry.register({ sessionId: "live", mode: "watch" });
    registry.emit("live", { type: "status", status: { kind: "running" } });

    expect(() => registry.register({ sessionId: "new", mode: "watch" })).toThrow();
    expect(registry.has("live")).toBe(true);
  });
});

describe("byte channels are per app", () => {
  it("routes a push to the named app and drops one for an unknown name", () => {
    const registry = makeRegistry();
    const entry = registry.register({
      sessionId: "s1",
      mode: "watch",
      apps: [{ name: "web" }, { name: "worker" }],
    });

    registry.pushBytes("s1", "web", Buffer.from("hello"));
    expect(entry.apps.get("web")!.byteBuffer.size).toBe(1);
    expect(entry.apps.get("worker")!.byteBuffer.size).toBe(0);

    expect(registry.pushBytes("s1", "nope", Buffer.from("x"))).toBeUndefined();
  });

  it("carries the stream tag through the buffer", () => {
    const registry = makeRegistry();
    registry.register({ sessionId: "s1", apps: [{ name: "app", io: "streams" }] });
    registry.pushBytes("s1", "app", Buffer.from("out"), "stdout");
    registry.pushBytes("s1", "app", Buffer.from("err"), "stderr");

    const entries = registry.get("s1")!.apps.get("app")!.byteBuffer.replay(0).entries;
    expect(entries.map((e) => e.stream)).toEqual(["stdout", "stderr"]);
  });

  it("has a sole app only when the session runs exactly one", () => {
    const registry = makeRegistry();
    const one = registry.register({ sessionId: "s1" });
    const two = registry.register({
      sessionId: "s2",
      apps: [{ name: "web" }, { name: "worker" }],
    });

    expect(registry.soleApp(one)?.name).toBe("app");
    expect(registry.soleApp(two)).toBeUndefined();
  });
});

describe("WatchSupervisor", () => {
  function watchEntry(registry: SessionRegistry, snapshot = vi.fn(async () => [])) {
    const entry = registry.register({ sessionId: "s1", mode: "watch" });
    const suspend = vi.fn(async () => {});
    entry.session = {
      writeStdin: () => {},
      resize: () => {},
      done: Promise.resolve(),
      stop: async () => {},
      suspend,
      workspace: {
        tree: async () => ({ files: [] }),
        readFile: async () => ({ content: "", size: 0 }),
        apply: async () => ({ written: 0, deleted: 0 }),
        snapshot,
      },
    } as unknown as SessionEntry["session"];
    registry.emit("s1", { type: "status", status: { kind: "running" } });
    return { entry, suspend, snapshot };
  }

  it("checkpoints on the timer while a client is attached", async () => {
    const registry = makeRegistry();
    const { entry, suspend, snapshot } = watchEntry(registry);
    registry.addSubscriber("s1");
    const supervisor = new WatchSupervisor({ registry, idleMs: 0, checkpointMs: 0 });

    await supervisor.tick();
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalled());

    expect(suspend).not.toHaveBeenCalled();
    expect(entry.checkpoint).not.toBeNull();
  });

  it("snapshots before suspending — the volume dies with the pod", async () => {
    const registry = makeRegistry();
    const order: string[] = [];
    const snapshot = vi.fn(async () => {
      order.push("snapshot");
      return [];
    });
    const { entry, suspend } = watchEntry(registry, snapshot);
    suspend.mockImplementation(async () => {
      order.push("suspend");
    });
    // No subscriber was ever added, so the entry is idle from registration.
    const supervisor = new WatchSupervisor({ registry, idleMs: 0, checkpointMs: 60_000 });

    await supervisor.tick();
    await vi.waitFor(() => expect(entry.status.kind).toBe("suspended"));

    expect(order).toEqual(["snapshot", "suspend"]);
    expect(entry.session).toBeNull();
  });

  it("does not suspend while a client is attached", async () => {
    const registry = makeRegistry();
    const { suspend } = watchEntry(registry);
    registry.addSubscriber("s1");
    const supervisor = new WatchSupervisor({ registry, idleMs: 0, checkpointMs: 60_000 });

    await supervisor.tick();
    await new Promise((r) => setTimeout(r, 20));

    expect(suspend).not.toHaveBeenCalled();
  });

  it("becomes idle again once the last subscriber detaches", async () => {
    const registry = makeRegistry();
    const { entry, suspend } = watchEntry(registry);
    const release = registry.addSubscriber("s1");
    expect(entry.idleSince).toBeNull();
    release();
    expect(entry.idleSince).not.toBeNull();

    const supervisor = new WatchSupervisor({ registry, idleMs: 0, checkpointMs: 60_000 });
    await supervisor.tick();
    await vi.waitFor(() => expect(suspend).toHaveBeenCalled());
  });

  it("leaves run sessions alone", async () => {
    const registry = makeRegistry();
    const entry = registry.register({ sessionId: "s2", mode: "run" });
    const suspend = vi.fn(async () => {});
    entry.session = { suspend } as unknown as SessionEntry["session"];
    registry.emit("s2", { type: "status", status: { kind: "running" } });

    const supervisor = new WatchSupervisor({ registry, idleMs: 0, checkpointMs: 0 });
    await supervisor.tick();
    await new Promise((r) => setTimeout(r, 20));

    expect(suspend).not.toHaveBeenCalled();
  });
});
