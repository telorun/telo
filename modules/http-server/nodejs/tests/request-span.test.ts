import { createCancellationSource } from "@telorun/sdk";
import Fastify from "fastify";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { create } from "../src/http-api-controller.js";

/**
 * Each inbound request opens a trace span attributed to the Http.Api and labelled
 * with the route, under which the handler invoke nests. This drives the real
 * controller (real Fastify) with a mock ResourceContext that captures the
 * `openSpan` call, asserting the controller passes the route's `{kind,name}`,
 * label and `{method,path}` attributes — and settles the span on success.
 *
 * The generic span mechanics (rooting a detached trace, nesting, trace id) are a
 * kernel concern, tested there; this test owns only the HTTP-specific wiring.
 */
describe("http-server request span", () => {
  it("opens a route-labelled span and dispatches the handler under it", async () => {
    const spanCalls: any[] = [];
    const settled: string[] = [];

    const handler = {
      async invoke(input: unknown) {
        return { echoed: (input as { value: number }).value };
      },
      snapshot: () => ({}),
    };

    const ctx = {
      validateSchema: () => {},
      resolveChildren: () => ({ kind: "JS.Script", name: "Echo" }),
      moduleContext: { expandWith: (value: unknown) => value },
      createCancellationSource: () => createCancellationSource(),
      invokeResolved: (_kind: string, _name: string, h: typeof handler, input: unknown) =>
        h.invoke(input),
      emitEvent: () => {},
      openSpan: async (base: unknown, opts: unknown) => {
        spanCalls.push(opts);
        return {
          context: base,
          settle: async (outcome: string) => {
            settled.push(outcome);
          },
        };
      },
    } as unknown as Parameters<typeof create>[1];

    const resource = {
      metadata: { name: "EchoApi", module: "test" },
      routes: [
        {
          request: { path: "/echo", method: "GET" },
          handler,
          inputs: { value: 1 },
          returns: [{ status: 200, content: { "application/json": { body: { ok: true } } } }],
        },
      ],
    };

    const api = await create(resource, ctx);
    const app = Fastify({ logger: false });
    api.register(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/echo`);
      expect(res.status).toBe(200);
      await res.json();

      expect(spanCalls).toHaveLength(1);
      expect(spanCalls[0]).toEqual({
        ref: { kind: "Http.Api", name: "EchoApi" },
        label: "GET /echo",
        attributes: { method: "GET", path: "/echo" },
      });
      expect(settled).toEqual(["ok"]);
    } finally {
      await app.close().catch(() => {});
    }
  });
});
