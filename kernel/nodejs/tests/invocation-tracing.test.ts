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

type Payload = Record<string, unknown> | undefined;

describe("invocation tracing — spanId in event payload", () => {
  it("does not mint span ids when tracing is off (default)", async () => {
    const kernel = await bootKernel();
    let payload: Payload;
    kernel.on("Echo.Invoked", (event) => {
      payload = event.payload as Payload;
    });

    await kernel.invoke("JS.Script.Echo", { value: 1 });
    expect(payload?.spanId).toBeUndefined();
    // The structured payload is still present; only the trace ids are absent.
    expect(payload?.ref).toMatchObject({ name: "Echo" });

    await kernel.teardown();
  });

  it("rides a unique, hex-rendered spanId on every dispatch event when tracing is on", async () => {
    const kernel = await bootKernel();
    kernel.setTracing(true);
    const payloads: Payload[] = [];
    kernel.on("Echo.Invoked", (event) => {
      payloads.push(event.payload as Payload);
    });

    await kernel.invoke("JS.Script.Echo", { value: 1 });
    await kernel.invoke("JS.Script.Echo", { value: 2 });

    expect(payloads[0]?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(payloads[0]).toMatchObject({ capability: "invoke", phase: "end", outcome: "ok" });
    // A root invoke has no parent.
    expect(payloads[0]?.parentSpanId).toBeUndefined();
    // Distinct across invocations. Deliberately NOT monotonic on the wire: §7.1
    // XORs the internal counter with a per-process salt so two services in one
    // distributed trace cannot both mint span id `1`. The counter stays
    // monotonic internally; the emitted id only has to be unique.
    expect(payloads[1]!.spanId).not.toBe(payloads[0]!.spanId);
    expect(payloads[1]?.spanId).toMatch(/^[0-9a-f]{16}$/);

    await kernel.teardown();
  });

  it("parents a nested sub-invoke to its caller's spanId", async () => {
    const kernel = await bootKernel();
    kernel.setTracing(true);
    const rootContext = (kernel as unknown as { rootContext: any }).rootContext;

    const byEvent = new Map<string, Payload>();
    kernel.on("*", (event) => {
      if (event.name.endsWith(".Invoked")) byEvent.set(event.name, event.payload as Payload);
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

    const outerPayload = byEvent.get("Outer.Invoked");
    const echoPayload = byEvent.get("Echo.Invoked");
    expect(outerPayload?.spanId).toMatch(/^[0-9a-f]{16}$/);
    // Outer is the trace root; Echo's parent is Outer.
    expect(outerPayload?.parentSpanId).toBeUndefined();
    expect(echoPayload?.parentSpanId).toBe(outerPayload?.spanId);

    await kernel.teardown();
  });
});
