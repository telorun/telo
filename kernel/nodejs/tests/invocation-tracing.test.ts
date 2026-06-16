import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { createCancellationSource } from "@telorun/sdk";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, "__fixtures__/invoke-cancellation/telo.yaml");

async function bootKernel(): Promise<Kernel> {
  const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
  await kernel.load(APP);
  await kernel.boot();
  return kernel;
}

type Meta = Record<string, unknown> | undefined;

describe("invocation tracing — invocationId in event metadata", () => {
  it("does not mint ids when tracing is off (default)", async () => {
    const kernel = await bootKernel();
    let meta: Meta = { sentinel: true };
    kernel.on("JS.Script.Echo.Invoked", (event) => {
      meta = event.metadata;
    });

    await kernel.invoke("JS.Script.Echo", { value: 1 });
    expect(meta).toBeUndefined();

    await kernel.teardown();
  });

  it("rides a monotonic invocationId on every invocation event when tracing is on", async () => {
    const kernel = await bootKernel();
    kernel.setTracing(true);
    const metas: Meta[] = [];
    kernel.on("JS.Script.Echo.Invoked", (event) => {
      metas.push(event.metadata);
    });

    await kernel.invoke("JS.Script.Echo", { value: 1 });
    await kernel.invoke("JS.Script.Echo", { value: 2 });

    expect(typeof metas[0]?.invocationId).toBe("number");
    // A root invoke has no parent.
    expect(metas[0]?.parentInvocationId).toBeUndefined();
    // Monotonic across invocations.
    expect(metas[1]!.invocationId as number).toBeGreaterThan(metas[0]!.invocationId as number);

    await kernel.teardown();
  });

  it("parents a nested sub-invoke to its caller's invocationId", async () => {
    const kernel = await bootKernel();
    kernel.setTracing(true);
    const rootContext = (kernel as unknown as { rootContext: any }).rootContext;

    const byEvent = new Map<string, Meta>();
    kernel.on("*", (event) => {
      if (event.name.endsWith(".Invoked")) byEvent.set(event.name, event.metadata);
    });

    // A composing controller whose nested invoke passes no context — it inherits
    // the caller's traced context via the kernel-internal ALS, exactly like a
    // real controller's `this.ctx.invoke(...)`.
    const outer = {
      invoke: async () => {
        await rootContext.invoke("JS.Script", "Echo", { value: 1 });
        return {};
      },
    };
    rootContext.resourceInstances.set("Outer", {
      resource: { kind: "Test.Outer", metadata: { name: "Outer" } },
      instance: outer,
    });

    const source = createCancellationSource();
    await rootContext.invokeResolved("Test.Outer", "Outer", outer, {}, source.context);

    const outerMeta = byEvent.get("Test.Outer.Outer.Invoked");
    const echoMeta = byEvent.get("JS.Script.Echo.Invoked");
    expect(typeof outerMeta?.invocationId).toBe("number");
    // Outer is the trace root; Echo's parent is Outer.
    expect(outerMeta?.parentInvocationId).toBeUndefined();
    expect(echoMeta?.parentInvocationId).toBe(outerMeta?.invocationId);

    await kernel.teardown();
  });
});
