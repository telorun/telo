import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
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

/**
 * Launch a deferred nested invoke from inside a fake target's `run()` — modelling
 * an inbound callback (an HTTP request) fired on a resource the target created.
 * AsyncLocalStorage propagates into the `setImmediate` callback, so whether the
 * deferred invoke inherits the target's trace context depends entirely on whether
 * the kernel established an ambient scope around `run()`.
 */
function deferredInvoker(rootContext: any) {
  let done!: Promise<void>;
  return {
    instance: {
      run: async () => {
        done = new Promise<void>((resolve) => {
          setImmediate(async () => {
            await rootContext.invoke("JS.Script", "Echo", { value: 1 });
            resolve();
          });
        });
      },
    },
    wait: () => done,
  };
}

describe("service trace detachment — a Service's run() does not leak its ambient scope", () => {
  it("detaches deferred work launched from a Service (separate root trace)", async () => {
    const kernel = await bootKernel();
    kernel.setTracing(true);
    const rootContext = (kernel as unknown as { rootContext: any }).rootContext;
    const orig = rootContext.getDefinition?.bind(rootContext);
    rootContext.getDefinition = (kind: string) =>
      kind === "Test.Service" ? { capability: "Telo.Service" } : orig?.(kind);

    const echoes: Payload[] = [];
    kernel.on("Echo.Invoked", (e) => echoes.push(e.payload as Payload));

    const svc = deferredInvoker(rootContext);
    await rootContext.runResolved("Test.Service", "Srv", svc.instance, undefined);
    await svc.wait();

    expect(echoes).toHaveLength(1);
    // The request-like deferred invoke is its own root — not parented to the service.
    expect(echoes[0]?.parentSpanId).toBeUndefined();

    await kernel.teardown();
  });

  it("keeps deferred work nested for a Runnable (ambient scope preserved)", async () => {
    const kernel = await bootKernel();
    kernel.setTracing(true);
    const rootContext = (kernel as unknown as { rootContext: any }).rootContext;
    const orig = rootContext.getDefinition?.bind(rootContext);
    rootContext.getDefinition = (kind: string) =>
      kind === "Test.Runnable" ? { capability: "Telo.Runnable" } : orig?.(kind);

    const runSpans: Payload[] = [];
    const echoes: Payload[] = [];
    kernel.on("Run.Run", (e) => runSpans.push(e.payload as Payload));
    kernel.on("Echo.Invoked", (e) => echoes.push(e.payload as Payload));

    const runnable = deferredInvoker(rootContext);
    await rootContext.runResolved("Test.Runnable", "Run", runnable.instance, undefined);
    await runnable.wait();

    expect(echoes).toHaveLength(1);
    // The runnable established an ambient scope, so its deferred invoke nests under it.
    expect(echoes[0]?.parentSpanId).toBe(runSpans[0]?.spanId);

    await kernel.teardown();
  });
});
