import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, "__fixtures__/invoke-cancellation/telo.yaml");

type Payload = Record<string, unknown> | undefined;

/**
 * `openSpan` is the generic inbound-boundary primitive: a controller (any
 * transport) opens a span that roots its own trace, and work dispatched under
 * `span.context` nests beneath it. This exercises the kernel primitive directly
 * with a synthetic ref — no transport module involved (transport-specific wiring
 * is tested in the module that owns it).
 */
describe("openSpan — inbound boundary span", () => {
  it("roots a detached trace, labels it, and nests dispatched work under it", async () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    await kernel.load(APP);
    await kernel.boot();
    kernel.setTracing(true);
    const rootContext = (kernel as unknown as { rootContext: any }).rootContext;

    const requests: Payload[] = [];
    const echoes: Payload[] = [];
    kernel.on("api.Request", (e) => {
      requests.push(e.payload as Payload);
    });
    kernel.on("Echo.Invoked", (e) => {
      echoes.push(e.payload as Payload);
    });

    const span = await rootContext.openSpan(undefined, {
      ref: { kind: "Test.Api", name: "api" },
      label: "GET /x",
      attributes: { method: "GET", path: "/x" },
    });
    await rootContext.invoke("JS.Script", "Echo", { value: 1 }, span.context);
    await span.settle("ok");

    expect(requests).toHaveLength(1);
    expect(echoes).toHaveLength(1);
    const request = requests[0]!;
    const echo = echoes[0]!;

    // The span roots its own trace, carries the structured trace contract.
    expect(request).toMatchObject({
      capability: "request",
      ref: { kind: "Test.Api", name: "api" },
      label: "GET /x",
      attributes: { method: "GET", path: "/x" },
      outcome: "ok",
    });
    expect(request.parentSpanId).toBeUndefined();
    expect(typeof request.traceId).toBe("string");

    // Work dispatched under span.context nests beneath it, same trace.
    expect(echo.parentSpanId).toBe(request.spanId);
    expect(echo.traceId).toBe(request.traceId);

    await kernel.teardown();
  });

  it("is a no-op pass-through when tracing is off", async () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    await kernel.load(APP);
    await kernel.boot();
    const rootContext = (kernel as unknown as { rootContext: any }).rootContext;

    let emitted = false;
    kernel.on("api.Request", () => {
      emitted = true;
    });

    const base = { cancellation: { isCancelled: false } } as any;
    const span = await rootContext.openSpan(base, { ref: { kind: "Test.Api", name: "api" } });
    await span.settle("ok");

    expect(span.context).toBe(base); // unchanged
    expect(emitted).toBe(false); // no span events when not tracing

    await kernel.teardown();
  });
});
