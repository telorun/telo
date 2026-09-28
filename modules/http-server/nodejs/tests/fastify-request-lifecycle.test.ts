import Fastify from "fastify";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

/**
 * The Fastify behaviour `Http.Server`'s request span rests on: a root `onRequest`
 * hook added first runs before every encapsulated hook and for a request no route
 * matched, and the raw response's `close` fires once the response completes —
 * a hijacked one included. A Fastify upgrade that changes either breaks the span.
 */
describe("fastify request lifecycle", () => {
  it("runs a root onRequest hook before encapsulated hooks and for not-found requests", async () => {
    const order: string[] = [];
    const app = Fastify({ logger: false });
    app.addHook("onRequest", async (request) => {
      order.push(`root ${request.url}`);
    });
    await app.register(async (scope) => {
      scope.addHook("onRequest", async () => {
        order.push("scoped");
      });
      scope.get("/inside", async () => "ok");
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    try {
      expect((await fetch(`http://127.0.0.1:${port}/inside`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${port}/missing`)).status).toBe(404);
      expect(order).toEqual(["root /inside", "scoped", "root /missing"]);
    } finally {
      await app.close();
    }
  });

  it("fires the raw response close after a normal and after a hijacked response", async () => {
    const closed: Array<{ url: string; ended: boolean; status: number }> = [];
    const app = Fastify({ logger: false });
    app.addHook("onRequest", async (request, reply) => {
      reply.raw.on("close", () => {
        closed.push({ url: request.url, ended: reply.raw.writableEnded, status: reply.raw.statusCode });
      });
    });
    app.get("/normal", async () => "ok");
    app.get("/hijacked", async (request, reply) => {
      reply.hijack();
      reply.raw.writeHead(202, { "content-type": "text/plain" });
      reply.raw.end("hijacked");
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    try {
      expect(await (await fetch(`http://127.0.0.1:${port}/normal`)).text()).toBe("ok");
      expect(await (await fetch(`http://127.0.0.1:${port}/hijacked`)).text()).toBe("hijacked");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(closed).toEqual([
        { url: "/normal", ended: true, status: 200 },
        { url: "/hijacked", ended: true, status: 202 },
      ]);
    } finally {
      await app.close();
    }
  });
});
