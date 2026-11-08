import { singleLanguageTranslations } from "./single-language-translations.js";
import { NOOP_LOGGER, createCancellationSource, type CancellationSource, type InvokeContext } from "@telorun/sdk";
import type { FastifyInstance } from "fastify";
import type { ServerResponse } from "node:http";
import net, { type AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { create as createServer } from "../src/http-server-controller.js";

/**
 * Stopping a server runs Fastify's close hooks while its connections drain, so
 * a hook that ends a long-lived response — an event stream — is what lets the
 * drain finish.
 */
describe("Http.Server stop", () => {
  it("runs the close hooks before waiting on open responses", async () => {
    const inverses: Array<() => unknown> = [];
    const chain = (steps: Array<() => Promise<any>>): any => ({
      effect: (reason: string, body: () => Promise<any>) => chain([...steps, body]),
      perform: async () => {
        for (const step of steps) {
          const outcome = await step();
          if (outcome.inverse) inverses.push(outcome.inverse);
        }
      },
    });
    const ctx = {
      translations: singleLanguageTranslations,
      log: NOOP_LOGGER,
      effect: (reason: string, body: () => Promise<any>) => chain([body]),
      acquireHold: () => () => {},
      claimListener: async () => null,
      emitEvent: async () => {},
      setStatus: async () => {},
      readPlainEncoded: (value: unknown) => value,
      createCancellationSource: () => createCancellationSource(),
      rootContext: (opts?: { cancellation?: CancellationSource }) => opts!.cancellation!.context,
      openSpan: async (base: InvokeContext) => ({ context: base, settle: async () => {} }),
    } as never;

    const open = new Set<ServerResponse>();
    const events = {
      register(scope: FastifyInstance) {
        scope.get("/events", (request, reply) => {
          reply.hijack();
          reply.raw.writeHead(200, { "content-type": "text/event-stream" });
          reply.raw.write("data: open\n\n");
          open.add(reply.raw);
        });
        scope.addHook("onClose", async () => {
          for (const response of open) response.end();
        });
      },
    };

    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const server = await createServer(
      {
        kind: "Http.Server",
        metadata: { name: "web", module: "test" },
        listen: { address: "127.0.0.1", port },
        mounts: [{ path: "/", mount: events }],
      } as never,
      ctx,
    );
    await (server!.init!(ctx) as any).perform();
    await (server!.run!(ctx) as any).perform();

    const response = await fetch(`http://127.0.0.1:${port}/events`);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: open\n\n");

    for (const inverse of inverses.reverse()) await inverse();
    expect(await reader.read()).toMatchObject({ done: true });
  }, 5_000);
});
