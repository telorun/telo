import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { MemorySource } from "../src/manifest-sources/memory-source.js";

const APP_YAML = `kind: Telo.Application
metadata:
  name: LifecycleTestApp
  version: 1.0.0
`;

function makeKernel(): { kernel: Kernel; memory: MemorySource } {
  const memory = new MemorySource();
  memory.set("app", APP_YAML);
  const kernel = new Kernel({ sources: [memory], env: {} });
  return { kernel, memory };
}

function recordEvents(kernel: Kernel): string[] {
  const events: string[] = [];
  for (const name of [
    "Kernel.Initialized",
    "Kernel.Starting",
    "Kernel.Started",
    "Kernel.Stopping",
    "Kernel.Stopped",
  ]) {
    kernel.on(name, () => events.push(name.replace("Kernel.", "")));
  }
  return events;
}

describe("Kernel lifecycle split", () => {
  describe("boot()", () => {
    it("initializes resources without running targets", async () => {
      const { kernel } = makeKernel();
      await kernel.load("memory://app");
      const events = recordEvents(kernel);

      await kernel.boot();

      expect(events).toEqual(["Initialized"]);
    });

    it("makes the kernel ready for invoke() before runTargets()", async () => {
      const { kernel } = makeKernel();
      await kernel.load("memory://app");
      await kernel.boot();

      // The kernel is ready — invoke() will reach the dispatcher and throw a
      // resource-not-found error (not the state-machine error). Either outcome
      // proves boot() unblocked the gate.
      let err: any;
      try {
        await kernel.invoke("NonExistent.Kind", {});
      } catch (e) {
        err = e;
      }
      expect(err).toBeDefined();
      expect(err.code).not.toBe("ERR_KERNEL_STATE_INVALID");
    });
  });

  describe("runTargets()", () => {
    it("emits Kernel.Starting then Kernel.Started", async () => {
      const { kernel } = makeKernel();
      await kernel.load("memory://app");
      await kernel.boot();
      const events = recordEvents(kernel);

      await kernel.runTargets();

      expect(events).toEqual(["Starting", "Started"]);
    });
  });

  describe("teardown()", () => {
    it("emits Kernel.Stopping then Kernel.Stopped", async () => {
      const { kernel } = makeKernel();
      await kernel.load("memory://app");
      await kernel.boot();
      const events = recordEvents(kernel);

      await kernel.teardown();

      expect(events).toEqual(["Stopping", "Stopped"]);
    });

    it("is idempotent — second call is a no-op and does not re-emit", async () => {
      const { kernel } = makeKernel();
      await kernel.load("memory://app");
      await kernel.boot();
      const events = recordEvents(kernel);

      await kernel.teardown();
      await kernel.teardown();

      expect(events).toEqual(["Stopping", "Stopped"]);
    });

    it("tolerates teardown after a load() that never reached boot()", async () => {
      const { kernel } = makeKernel();
      await kernel.load("memory://app");

      // Never called boot(); teardown still cleans up (no resources to tear down).
      await expect(kernel.teardown()).resolves.toBeUndefined();
    });

    it("tolerates teardown before load() (no rootContext yet)", async () => {
      const memory = new MemorySource();
      memory.set("app", APP_YAML);
      const kernel = new Kernel({ sources: [memory], env: {} });

      await expect(kernel.teardown()).resolves.toBeUndefined();
    });
  });

  describe("state machine", () => {
    it("boot() called twice throws ERR_KERNEL_STATE_INVALID", async () => {
      const { kernel } = makeKernel();
      await kernel.load("memory://app");
      await kernel.boot();

      await expect(kernel.boot()).rejects.toMatchObject({
        code: "ERR_KERNEL_STATE_INVALID",
      });
    });

    it("runTargets() before boot() throws", async () => {
      const { kernel } = makeKernel();
      await kernel.load("memory://app");

      await expect(kernel.runTargets()).rejects.toMatchObject({
        code: "ERR_KERNEL_STATE_INVALID",
      });
    });

    it("runTargets() called twice throws", async () => {
      const { kernel } = makeKernel();
      await kernel.load("memory://app");
      await kernel.boot();
      await kernel.runTargets();

      await expect(kernel.runTargets()).rejects.toMatchObject({
        code: "ERR_KERNEL_STATE_INVALID",
      });
    });

    it("runTargets() after teardown() throws", async () => {
      const { kernel } = makeKernel();
      await kernel.load("memory://app");
      await kernel.boot();
      await kernel.teardown();

      await expect(kernel.runTargets()).rejects.toMatchObject({
        code: "ERR_KERNEL_STATE_INVALID",
      });
    });

    it("invoke() before boot() throws", async () => {
      const { kernel } = makeKernel();
      await kernel.load("memory://app");

      await expect(kernel.invoke("Foo.Bar", {})).rejects.toMatchObject({
        code: "ERR_KERNEL_STATE_INVALID",
      });
    });

    it("invoke() after teardown() throws", async () => {
      const { kernel } = makeKernel();
      await kernel.load("memory://app");
      await kernel.boot();
      await kernel.teardown();

      await expect(kernel.invoke("Foo.Bar", {})).rejects.toMatchObject({
        code: "ERR_KERNEL_STATE_INVALID",
      });
    });

    it("boot() after teardown() throws", async () => {
      const { kernel } = makeKernel();
      await kernel.load("memory://app");
      await kernel.boot();
      await kernel.teardown();

      await expect(kernel.boot()).rejects.toMatchObject({
        code: "ERR_KERNEL_STATE_INVALID",
      });
    });
  });

  describe("invoke() ref parsing", () => {
    it("rejects refs without a dot", async () => {
      const { kernel } = makeKernel();
      await kernel.load("memory://app");
      await kernel.boot();

      await expect(kernel.invoke("NoDot", {})).rejects.toMatchObject({
        code: "ERR_INVALID_VALUE",
      });
    });

    it("rejects refs with a trailing dot", async () => {
      const { kernel } = makeKernel();
      await kernel.load("memory://app");
      await kernel.boot();

      await expect(kernel.invoke("Trailing.", {})).rejects.toMatchObject({
        code: "ERR_INVALID_VALUE",
      });
    });

    it("rejects refs with a leading dot", async () => {
      const { kernel } = makeKernel();
      await kernel.load("memory://app");
      await kernel.boot();

      await expect(kernel.invoke(".Leading", {})).rejects.toMatchObject({
        code: "ERR_INVALID_VALUE",
      });
    });
  });

  describe("start() contract preservation", () => {
    it("produces the same event order as before the split", async () => {
      const { kernel } = makeKernel();
      await kernel.load("memory://app");
      const events = recordEvents(kernel);

      await kernel.start();

      expect(events).toEqual(["Initialized", "Starting", "Started", "Stopping", "Stopped"]);
    });

    it("tolerates teardown() after a load() that itself threw", async () => {
      // load() rejects when an import points at a missing source. The kernel
      // should still be in a safe state for teardown() — no half-initialized
      // resources, no thrown errors from cleanup.
      const memory = new MemorySource();
      memory.set(
        "bad-app",
        `kind: Telo.Application
metadata:
  name: BadApp
  version: 1.0.0
---
kind: Telo.Import
metadata: { name: Missing }
source: memory://does-not-exist
`,
      );
      const kernel = new Kernel({ sources: [memory], env: {} });

      await expect(kernel.load("memory://bad-app")).rejects.toBeDefined();
      await expect(kernel.teardown()).resolves.toBeUndefined();
    });

    it("start() runs teardown via finally when boot() throws, and re-throws", async () => {
      // Skipping load() makes boot() throw ERR_KERNEL_STATE_INVALID. start()'s
      // try/finally must still drive teardown — emitting Stopping/Stopped — and
      // propagate the original error to the caller.
      const memory = new MemorySource();
      memory.set("app", APP_YAML);
      const kernel = new Kernel({ sources: [memory], env: {} });
      const events = recordEvents(kernel);

      await expect(kernel.start()).rejects.toMatchObject({
        code: "ERR_KERNEL_STATE_INVALID",
      });
      expect(events).toEqual(["Stopping", "Stopped"]);
    });
  });

  describe("forceIdle()", () => {
    it("resolves a pending waitForIdle() even when holds are active", async () => {
      const { kernel } = makeKernel();
      await kernel.load("memory://app");
      await kernel.boot();

      kernel.acquireHold("test-hold");
      const idle = kernel.waitForIdle();

      let resolved = false;
      const tracker = idle.then(() => {
        resolved = true;
      });

      // Give the event loop a tick; idle should still be pending.
      await new Promise<void>((r) => setImmediate(r));
      expect(resolved).toBe(false);

      kernel.forceIdle();
      await tracker;
      expect(resolved).toBe(true);
    });

    it("is a no-op when no waiters are pending", () => {
      const { kernel } = makeKernel();
      expect(() => kernel.forceIdle()).not.toThrow();
    });
  });
});
