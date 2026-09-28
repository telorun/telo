import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, "__fixtures__/invoke-cancellation/telo.yaml");
const TRACED_APP = path.resolve(here, "__fixtures__/trace-export/telo.yaml");

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
    kernel.on("echo.Invoked", (e) => {
      echoes.push(e.payload as Payload);
    });

    const span = await rootContext.openSpan(undefined, {
      ref: { kind: "Test.Api", name: "api" },
      label: "GET /x",
      attributes: { method: "GET", path: "/x" },
    });
    await rootContext.invoke("JS.Script", "echo", { value: 1 }, span.context);
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

  it("parents a span under the span its base context carries, and exports what settle adds", async () => {
    // Tracing is on because the app lists a trace sink (`Telo.LogTraceSink`),
    // which writes each finished span as one JSON record on stdout.
    const chunks: string[] = [];
    const stdout = { write: (chunk: string) => void chunks.push(String(chunk)) } as never;
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {}, stdout });
    await kernel.load(TRACED_APP);
    await kernel.boot();
    const rootContext = (kernel as unknown as { rootContext: any }).rootContext;

    const ref = { kind: "Test.Agent", name: "agent" };
    const outer = await rootContext.openSpan(undefined, { ref, label: "invoke_agent agent" });
    const inner = await rootContext.openSpan(outer.context, {
      ref,
      label: "execute_tool lookup",
      attributes: { "gen_ai.tool.name": "lookup" },
    });
    await inner.settle("failed", { attributes: { "error.type": "ERR_LOOKUP" } });
    await outer.settle("ok");
    await kernel.teardown();

    const exported = chunks
      .join("")
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, any>)
      .filter((record) => record.event_name === "telo.span");
    const parent = exported.find((span) => span.msg === "invoke_agent agent")!;
    const child = exported.find((span) => span.msg === "execute_tool lookup")!;
    expect(parent.attributes).toMatchObject({ "telo.span.outcome": "ok" });
    expect(parent.attributes["telo.span.parent_span_id"]).toBeUndefined();
    expect(child.trace_id).toBe(parent.trace_id);
    expect(child.attributes).toMatchObject({
      "telo.span.parent_span_id": parent.span_id,
      "telo.span.outcome": "failed",
      "gen_ai.tool.name": "lookup",
      "error.type": "ERR_LOOKUP",
    });
    expect(child.attributes["telo.span.duration_ms"]).toBeGreaterThanOrEqual(0);
  });

  /** Opens one inbound span with the given `traceparent` and a child under it on
   *  the traced fixture, returning both as `Telo.LogTraceSink` exported them. */
  async function exportInbound(traceparent: string) {
    const chunks: string[] = [];
    const stdout = { write: (chunk: string) => void chunks.push(String(chunk)) } as never;
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {}, stdout });
    await kernel.load(TRACED_APP);
    await kernel.boot();
    const rootContext = (kernel as unknown as { rootContext: any }).rootContext;
    const ref = { kind: "Test.Server", name: "server" };
    const request = await rootContext.openSpan(undefined, {
      ref,
      label: "GET /items",
      inbound: { traceparent },
    });
    const child = await rootContext.openSpan(request.context, { ref, label: "child" });
    await child.settle("ok");
    await request.settle("ok");
    await kernel.teardown();
    const exported = chunks
      .join("")
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, any>)
      .filter((record) => record.event_name === "telo.span");
    return {
      request: exported.find((span) => span.msg === "GET /items")!,
      child: exported.find((span) => span.msg === "child")!,
    };
  }

  it("continues a valid inbound traceparent under the upstream parent, verbatim", async () => {
    const trace = "4bf92f3577b34da6a3ce929d0e0e4736";
    const parent = "00f067aa0ba902b7";
    const { request, child } = await exportInbound(`00-${trace}-${parent}-01`);
    expect(request.trace_id).toBe(trace);
    expect(request.attributes["telo.span.parent_span_id"]).toBe(parent);
    expect(child.trace_id).toBe(trace);
    expect(child.attributes["telo.span.parent_span_id"]).toBe(request.span_id);
  });

  it.each([
    ["an all-zero trace id", "00-00000000000000000000000000000000-00f067aa0ba902b7-01"],
    ["an all-zero parent id", "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01"],
    ["a malformed header", "not-a-traceparent"],
  ])("ignores %s in full and roots a new trace", async (_case, traceparent) => {
    const { request, child } = await exportInbound(traceparent);
    expect(request.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(request.trace_id).not.toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(request.attributes["telo.span.parent_span_id"]).toBeUndefined();
    expect(child.attributes["telo.span.parent_span_id"]).toBe(request.span_id);
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
