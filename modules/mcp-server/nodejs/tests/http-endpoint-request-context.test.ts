import type { InvokeContext, ResourceContext } from "@telorun/sdk";
import Fastify, { type FastifyRequest } from "fastify";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { McpHttpEndpoint } from "../src/http-endpoint-controller.js";
import { McpToolsBundle } from "../src/tools-controller.js";

/**
 * `Mcp.HttpEndpoint` dispatches each tool call on the context of the HTTP request
 * that carried it — the one the transport's request scope hands out — and refuses
 * a request when it was mounted with no scope, rather than rooting a trace of its
 * own.
 */
async function serve(
  requestScope: { forRequest(request: FastifyRequest): { context: InvokeContext } } | undefined,
) {
  const dispatched: unknown[] = [];
  const handler = { invoke: async () => ({ ok: true }) };
  const ctx = {
    moduleContext: { expandWith: (value: unknown) => value },
    invokeResolved: async (
      _kind: string,
      _name: string,
      _instance: unknown,
      _inputs: unknown,
      context: unknown,
    ) => {
      dispatched.push(context);
      return { ok: true };
    },
    emitEvent: async () => {},
  } as unknown as ResourceContext;
  const raw = [
    {
      name: "ping",
      handler,
      result: { content: [{ type: "text", text: "pong" }] },
    },
  ];
  const tools = new McpToolsBundle(
    "tools",
    raw,
    new Map([[raw[0], { kind: "Test.Handler", name: "ping" }]]),
    ctx,
  );
  const endpoint = new McpHttpEndpoint(
    {
      kind: "Mcp.HttpEndpoint",
      metadata: { name: "mcp" },
      serverInfo: { name: "test", version: "1.0.0" },
      tools: [tools as unknown as string],
    },
    ctx,
  );
  await endpoint.init();
  const app = Fastify({ logger: false });
  endpoint.register(app, "/mcp", requestScope as never);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address() as AddressInfo;
  const call = () =>
    fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "ping", arguments: {} },
      }),
    });
  return { app, call, dispatched };
}

describe("Mcp.HttpEndpoint request context", () => {
  it("dispatches a tool call on the context the request scope supplies", async () => {
    const context = { cancellation: { isCancelled: false } } as unknown as InvokeContext;
    const { app, call, dispatched } = await serve({ forRequest: () => ({ context }) });
    try {
      const response = await call();
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("pong");
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toBe(context);
    } finally {
      await app.close();
    }
  });

  it("refuses a request when mounted without a request scope", async () => {
    const { app, call, dispatched } = await serve(undefined);
    try {
      const response = await call();
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ code: "ERR_MCP_REQUEST_SCOPE_MISSING" });
      expect(dispatched).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
