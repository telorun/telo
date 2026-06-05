import { ERR_INVOKE_CANCELLED, InvokeError, createCancellationSource } from "@telorun/sdk";
import Fastify from "fastify";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { create } from "../src/http-api-controller.js";

/**
 * The route handler must be cancelled when the client disconnects before the
 * response is sent. The controller wires per-request cancellation to the
 * response socket's `close`; this drives the real controller end-to-end (real
 * Fastify, real socket) and asserts the cancellation token reached the handler.
 *
 * Node-only by nature: Bun's `node:http` does not fire the response-socket
 * `close` before the response on a disconnect, so this can't be observed there.
 * That's why it lives here (vitest, run under Node) rather than as a YAML test
 * in the Bun-run suite. The bug fix it guards — cancelling on the *response*
 * socket so a fully-read-but-still-connected request is NOT spuriously
 * cancelled — is exercised by the registry e2e on both runtimes.
 */
describe("http-server request cancellation", () => {
  it("cancels the handler when the client disconnects mid-request", async () => {
    let handlerEntered = false;
    let handlerCancelled = false;

    const handler = {
      async invoke(_input: unknown, invokeCtx?: { cancellation?: any }) {
        handlerEntered = true;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 3000);
          invokeCtx?.cancellation?.onCancelled(() => {
            clearTimeout(timer);
            handlerCancelled = true;
            reject(new InvokeError(ERR_INVOKE_CANCELLED, "cancelled while waiting"));
          });
        });
        return { ok: true };
      },
      snapshot: () => ({}),
    };

    // Minimal ResourceContext: just the surface the controller touches.
    const ctx = {
      validateSchema: () => {},
      resolveChildren: () => ({ kind: "Test.Handler", name: "SlowWork" }),
      moduleContext: { expandWith: (value: unknown) => value },
      createCancellationSource: () => createCancellationSource(),
      invokeResolved: (_kind: string, _name: string, h: typeof handler, input: unknown, c: unknown) =>
        h.invoke(input, c as { cancellation?: any }),
      emitEvent: () => {},
    } as unknown as Parameters<typeof create>[1];

    const resource = {
      metadata: { name: "SlowApi", module: "test" },
      routes: [
        {
          request: { path: "/slow", method: "PUT", schema: { body: { type: "string" } } },
          handler,
          inputs: {},
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
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host: "127.0.0.1", port });
        socket.on("error", reject);
        socket.on("connect", () => {
          const body = "x";
          socket.write(
            `PUT /slow HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
              `Content-Type: text/plain\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
          );
          // Let the handler enter its wait, then hard-close (real disconnect).
          setTimeout(() => {
            socket.destroy();
            resolve();
          }, 200);
        });
      });

      // Allow the response-socket close → cancellation → handler rejection to settle.
      await new Promise((r) => setTimeout(r, 400));

      expect(handlerEntered).toBe(true);
      expect(handlerCancelled).toBe(true);
    } finally {
      await app.close().catch(() => {});
    }
  });
});
