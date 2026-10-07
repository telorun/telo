import Fastify from "fastify";
import { mkdtempSync, writeFileSync } from "node:fs";
import { get, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { create, type AppResource } from "../src/app-controller.js";

afterEach(() => vi.useRealTimers());

interface Faults {
  /** The stream's effect cannot be performed. */
  start?: Error;
  /** The stream's effect cannot be undone. */
  dispose?: Error;
}

/** As much of a resource context as an application with one static page uses. */
function context(faults: Faults = {}) {
  const directory = mkdtempSync(join(tmpdir(), "ui-react-events-"));
  const logged: { message: string; attributes: Record<string, unknown> }[] = [];
  const live = new Set<object>();
  return {
    logged,
    /** The effects performed and not yet disposed. */
    live,
    effect: (reason: string, body: () => Promise<{ result: unknown; inverse?: () => unknown }>) => ({
      async perform() {
        if (faults.start) throw faults.start;
        const outcome = await body();
        const handle = {
          result: outcome.result,
          async dispose() {
            if (!live.delete(handle)) return;
            await outcome.inverse?.();
            if (faults.dispose) throw faults.dispose;
          },
        };
        live.add(handle);
        return handle;
      },
    }),
    async resolveControllerBrowserEntry(specifier: string) {
      const file = join(directory, `${specifier.replace(/[^a-z]/g, "-")}.js`);
      writeFileSync(file, "export {};");
      return { specifier, file: pathToFileURL(file).href, siblings: [], digest: specifier, abi: "ui_react-1", external: [], exports: [] };
    },
    createTypeValidator: () => ({ validate() {}, isValid: () => true }),
    log: { error: (message: string, attributes: Record<string, unknown>) => void logged.push({ message, attributes }) },
  };
}

const RESOURCE = { kind: "UiReact.App", metadata: { name: "admin" }, title: "Events", pages: [{ path: "/", title: "Home", children: [] }] };

/** The application listening under `/admin`, and how to open a stream on it. */
async function listening(ctx: ReturnType<typeof context>) {
  const app = await create(RESOURCE as unknown as AppResource, ctx as never);
  const server = Fastify();
  app.register(server, "/admin");
  await server.listen({ host: "127.0.0.1", port: 0 });
  const { port } = server.server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/admin/_telo/ui/events`;
  return { server, open: () => new Promise<IncomingMessage>((resolve, reject) => get(url, resolve).on("error", reject)) };
}

describe("an event stream", () => {
  it("says hello, keeps alive, and ends with the server without holding it open", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const resource = { kind: "UiReact.App", metadata: { name: "admin" }, title: "Events", pages: [{ path: "/", title: "Home", children: [] }] };
    const app = await create(resource as unknown as AppResource, context() as never);
    const server = Fastify();
    app.register(server, "/admin");
    await server.listen({ host: "127.0.0.1", port: 0 });
    const { port } = server.server.address() as AddressInfo;

    let received = "";
    let ended = false;
    const response = await new Promise<IncomingMessage>((resolve) => get(`http://127.0.0.1:${port}/admin/_telo/ui/events`, resolve));
    response.setEncoding("utf8");
    response.on("data", (chunk) => (received += chunk));
    response.on("end", () => (ended = true));
    await vi.waitFor(() => expect(received).toMatch(/^event: hello\ndata: \{"bundle":"[0-9a-f]{64}"\}\n\n$/));
    expect(response.headers["content-type"]).toBe("text/event-stream");

    vi.advanceTimersByTime(25_000);
    await vi.waitFor(() => expect(received.endsWith(": keepalive\n\n")).toBe(true));

    const stopped = await Promise.race([
      server.close().then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("still open"), 3_000)),
    ]);
    expect(stopped).toBe("closed");
    await vi.waitFor(() => expect(ended).toBe(true));
    const atEnd = received;
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(received).toBe(atEnd);
  });

  it("holds one effect while it is open, and none once its client has gone", async () => {
    const ctx = context();
    const { server, open } = await listening(ctx);
    for (let round = 0; round < 25; round++) {
      const response = await open();
      await vi.waitFor(() => expect(ctx.live.size).toBe(1));
      response.destroy();
      await vi.waitFor(() => expect(ctx.live.size).toBe(0));
    }
    expect(ctx.logged).toEqual([]);
    await server.close();
  });

  it("destroys the connection and reports it when the stream cannot start", async () => {
    const ctx = context({ start: new Error("the application is being torn down") });
    const { server, open } = await listening(ctx);
    await expect(open()).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(ctx.logged).toEqual([
      { message: "An event stream could not be started", attributes: { owner: "UiReact.App 'admin'", message: "the application is being torn down" } },
    ]);
    await server.close();
  });

  it("reports a stream that could not be released when its client went", async () => {
    const ctx = context({ dispose: new Error("the inverse refused") });
    const { server, open } = await listening(ctx);
    const response = await open();
    response.destroy();
    await vi.waitFor(() =>
      expect(ctx.logged).toEqual([
        { message: "An event stream could not be released when it closed", attributes: { owner: "UiReact.App 'admin'", message: "the inverse refused" } },
      ]),
    );
    // The fault is the test's own: stop the server without waiting on streams.
    await server.close();
  });
});
