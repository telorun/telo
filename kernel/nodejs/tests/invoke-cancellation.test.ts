import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import {
  createCancellationSource,
  ERR_INVOKE_CANCELLED,
  isCancellationError,
  NEVER_CANCELLED,
  UNCANCELLABLE_CONTEXT,
} from "@telorun/sdk";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, "__fixtures__/invoke-cancellation/telo.yaml");
const TARGETS_APP = path.resolve(here, "__fixtures__/invoke-cancellation-targets/telo.yaml");

async function bootKernel(): Promise<Kernel> {
  const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
  await kernel.load(APP);
  await kernel.boot();
  return kernel;
}

describe("invoke cancellation — kernel dispatch gate", () => {
  it("invokes normally when no cancellation is seeded (sentinel path)", async () => {
    const kernel = await bootKernel();
    const result = await kernel.invoke("JS.Script.Echo", { value: 42 });
    expect(result).toEqual({ echoed: 42 });
    await kernel.teardown();
  });

  it("refuses an invoke whose external signal is already aborted, before dispatch", async () => {
    const kernel = await bootKernel();
    const controller = new AbortController();
    controller.abort("gone");

    await expect(
      kernel.invoke("JS.Script.Echo", { value: 1 }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "ERR_INVOKE_CANCELLED" });

    await kernel.teardown();
  });

  it("refuses an invoke whose deadline has already passed", async () => {
    const kernel = await bootKernel();

    await expect(
      kernel.invoke("JS.Script.Echo", { value: 1 }, { deadlineAt: Date.now() - 1000 }),
    ).rejects.toMatchObject({ code: "ERR_INVOKE_CANCELLED" });

    await kernel.teardown();
  });

  it("emits a scoped InvokeCancelled event when the gate refuses", async () => {
    const kernel = await bootKernel();
    let cancelledReason: unknown = "unset";
    kernel.on("Echo.InvokeCancelled", (event) => {
      cancelledReason = (event.payload as { reason?: unknown })?.reason;
    });
    const controller = new AbortController();
    controller.abort("client-gone");

    await expect(
      kernel.invoke("JS.Script.Echo", { value: 1 }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "ERR_INVOKE_CANCELLED" });
    expect(cancelledReason).toBe("client-gone");

    await kernel.teardown();
  });
});

describe("nested inheritance — ALS-propagated tree token", () => {
  it("refuses a composing controller's nested sub-invoke once the tree is cancelled", async () => {
    const kernel = await bootKernel();
    const rootContext = (kernel as unknown as { rootContext: any }).rootContext;
    const source = createCancellationSource();
    const seen: string[] = [];

    // A composing controller whose nested `invoke`s pass NO context — they
    // inherit the tree token purely via the kernel-internal AsyncLocalStorage,
    // exactly as a real controller's `this.ctx.invoke(...)` does. Cancelling
    // mid-flight must refuse the second sub-invoke at the gate.
    const outer = {
      invoke: async () => {
        await rootContext.invoke("JS.Script", "Echo", { value: 1 });
        seen.push("first-ran");
        source.cancel("mid-flight");
        await rootContext.invoke("JS.Script", "Echo", { value: 2 });
        seen.push("second-ran"); // unreachable — refused by inheritance
        return {};
      },
    };
    rootContext.resourceInstances.set("Outer", {
      resource: { kind: "Test.Outer", metadata: { name: "Outer" } },
      instance: outer,
    });

    await expect(
      rootContext.invokeResolved("Test.Outer", "Outer", outer, {}, source.context),
    ).rejects.toMatchObject({ code: "ERR_INVOKE_CANCELLED" });
    // First sub-invoke inherited a live token and ran; second inherited the
    // now-cancelled token and was gated.
    expect(seen).toEqual(["first-ran"]);

    await kernel.teardown();
  });
});

describe("boot targets — kernel.cancel()", () => {
  it("runs the boot targets normally when not cancelled", async () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    await kernel.load(TARGETS_APP);
    await kernel.boot();
    await expect(kernel.runTargets()).resolves.toBeUndefined();
    await kernel.teardown();
  });

  it("refuses boot targets once the boot run is cancelled (e.g. SIGINT)", async () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    await kernel.load(TARGETS_APP);
    await kernel.boot();

    kernel.cancel("interrupted"); // what the CLI signal handler calls

    await expect(kernel.runTargets()).rejects.toMatchObject({ code: "ERR_INVOKE_CANCELLED" });
    await kernel.teardown();
  });
});

describe("cancellation primitives — source/token split", () => {
  it("polls, exposes a reason, and aborts the signal on cancel", () => {
    const source = createCancellationSource();
    expect(source.token.isCancelled).toBe(false);
    expect(source.token.signal.aborted).toBe(false);

    source.cancel("client-disconnect");

    expect(source.token.isCancelled).toBe(true);
    expect(source.token.reason).toBe("client-disconnect");
    expect(source.token.signal.aborted).toBe(true);
  });

  it("fires onCancelled subscribers once, and immediately if already cancelled", () => {
    const source = createCancellationSource();
    const reasons: (string | undefined)[] = [];
    source.token.onCancelled((r) => reasons.push(r));

    source.cancel("a");
    source.cancel("b"); // second cancel is a no-op
    source.token.onCancelled((r) => reasons.push(`late:${r}`));

    expect(reasons).toEqual(["a", "late:a"]);
  });

  it("throwIfCancelled throws the structured cancellation error only after cancel", () => {
    const source = createCancellationSource();
    expect(() => source.token.throwIfCancelled()).not.toThrow();

    source.cancel("stop");
    let thrown: unknown;
    try {
      source.token.throwIfCancelled();
    } catch (err) {
      thrown = err;
    }
    expect(isCancellationError(thrown)).toBe(true);
    expect((thrown as { code: string }).code).toBe(ERR_INVOKE_CANCELLED);
  });

  it("cancelAfter trips after the delay (deadline as scheduled cancellation)", async () => {
    const source = createCancellationSource();
    source.cancelAfter(5);
    expect(source.token.isCancelled).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(source.token.isCancelled).toBe(true);
  });

  it("dispose() clears a pending cancelAfter so it never trips", async () => {
    const source = createCancellationSource();
    source.cancelAfter(5);
    source.dispose();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(source.token.isCancelled).toBe(false);
  });

  it("the sentinel context is never cancellable", () => {
    expect(NEVER_CANCELLED.isCancelled).toBe(false);
    expect(UNCANCELLABLE_CONTEXT.cancellation).toBe(NEVER_CANCELLED);
    expect(() => NEVER_CANCELLED.throwIfCancelled()).not.toThrow();
  });
});
