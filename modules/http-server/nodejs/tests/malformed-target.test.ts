import { singleLanguageTranslations } from "./single-language-translations.js";
import {
  NOOP_LOGGER,
  createCancellationSource,
  type CancellationSource,
  type InvokeContext,
  type Logger,
  type NeedResolution,
} from "@telorun/sdk";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { create as createApi } from "../src/http-api-controller.js";
import { create as createServer } from "../src/http-server-controller.js";
import { create as createStatic } from "../src/http-static-controller.js";

/**
 * A request whose path holds a percent-escape that does not decode is one no
 * route matches: answered by the not-found handler governing its prefix, through
 * the same hooks as any unknown path, and seen by every handler as sent. Targets
 * are written byte for byte over a socket, since an HTTP client normalises them.
 */

const INDEX = "<!doctype html><title>shell</title>";

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function expandWith(value: unknown, celCtx: Record<string, unknown>): unknown {
  if (typeof value === "function") return value(celCtx);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandWith(v, celCtx)]));
  }
  return value;
}

type Record_ = { eventName: string | undefined; attributes: Record<string, unknown> };

function testContext(listenPort: number) {
  const spans: Array<{ settled: Array<{ outcome: string; attributes?: Record<string, unknown> }> }> = [];
  const records: Record_[] = [];
  const invoked: string[] = [];
  const log: Logger = {
    ...NOOP_LOGGER,
    enabled: () => true,
    log: (_severity, _message, attributes, options) => {
      records.push({ eventName: options?.eventName, attributes: { ...attributes } });
    },
    debug: (_message, attributes, options) => {
      records.push({ eventName: options?.eventName, attributes: { ...attributes } });
    },
    with: () => log,
  };
  const inverses: Array<() => unknown> = [];
  const chain = (steps: Array<(input: unknown) => Promise<any>>): any => ({
    effect: (_reason: string, body: (input: unknown) => Promise<any>) => chain([...steps, body]),
    perform: async () => {
      let value: unknown;
      for (const step of steps) {
        const outcome = await step(value);
        if (outcome.inverse) inverses.push(outcome.inverse);
        value = outcome.result;
      }
      return { result: value, dispose: async () => {} };
    },
  });
  const resolveNeed = (): NeedResolution => ({
    target: { id: "site", ref: { kind: "Telo.PublicUrl", name: "site" } } as never,
    fields: { url: { host: "shop.example" } },
    sensitive: [],
    constraints: {},
    parameters: { port: "http" },
    port: listenPort,
  });
  const dispatch = async (name: string, inputs: unknown) => {
    invoked.push(name);
    return name === "missing" ? { status: 404, body: { path: (inputs as { path: string }).path } } : { id: "ok" };
  };
  const ctx = {
    translations: singleLanguageTranslations,
    log,
    effect: (_reason: string, body: (input: unknown) => Promise<any>) => chain([body]),
    acquireHold: () => () => {},
    claimListener: async () => null,
    emitEvent: async () => {},
    setStatus: async () => {},
    readPlainEncoded: (value: unknown) => value,
    ensureKindRef: (value: { kind: string; name: string }) => value,
    moduleContext: { expandWith },
    validateSchema: () => {},
    createCancellationSource: () => createCancellationSource(),
    rootContext: (opts?: { cancellation?: CancellationSource }) => opts!.cancellation!.context,
    openSpan: async (base: InvokeContext) => {
      const span = { settled: [] as Array<{ outcome: string; attributes?: Record<string, unknown> }> };
      spans.push(span);
      return {
        context: base,
        settle: async (outcome: string, detail?: { attributes?: Record<string, unknown> }) => {
          span.settled.push({ outcome, attributes: detail?.attributes });
        },
      };
    },
    invoke: (_kind: string, name: string, inputs: unknown) => dispatch(name, inputs),
    invokeResolved: (_kind: string, name: string, _instance: unknown, inputs: unknown) =>
      dispatch(name, inputs),
    resolveNeed,
    declaredDisplayMessage: () => undefined,
  };
  const unwind = async () => {
    for (const inverse of inverses.reverse()) await inverse();
  };
  return { ctx: ctx as never, spans, records, invoked, unwind };
}

let running: { unwind(): Promise<void> } | undefined;
let staticRoot: string | undefined;
afterEach(async () => {
  await running?.unwind();
  running = undefined;
  if (staticRoot) await rm(staticRoot, { recursive: true });
  staticRoot = undefined;
});

/**
 * `/api/items/:id`, an `Http.Static` `spaFallback` mount at `/app`, and a mount
 * answering only `site`'s host (what `unknownHosts: reject` requires).
 */
async function start(extra: Record<string, unknown> = {}) {
  const port = await freePort();
  const harness = testContext(port);
  staticRoot = await mkdtemp(join(tmpdir(), "telo-malformed-target-"));
  await writeFile(join(staticRoot, "index.html"), INDEX);
  const route = (path: string) => ({
    request: { path, method: "GET" },
    handler: { kind: "Test.Handler", name: "items" },
    returns: [{ status: 200, content: { "application/json": { body: { ok: true } } } }],
  });
  const api = await createApi({ metadata: { name: "api" }, routes: [route("/items/:id")] } as never, harness.ctx);
  const site = await createApi({ metadata: { name: "site" }, routes: [route("/who")] } as never, harness.ctx);
  const spa = await createStatic(
    { kind: "Http.Static", metadata: { name: "spa" }, root: staticRoot, spaFallback: true } as never,
  );
  const server = await createServer(
    {
      kind: "Http.Server",
      metadata: { name: "web", module: "test" },
      listen: { address: "127.0.0.1", port },
      mounts: [
        { path: "/api", mount: api },
        { path: "/app", mount: spa },
        { path: "/site", mount: site, hostnames: [{ kind: "Telo.PublicUrl", name: "site" }] },
      ],
      ...extra,
    } as never,
    harness.ctx,
  );
  await (server!.init!(harness.ctx as never) as any).perform();
  await (server!.run!(harness.ctx as never) as any).perform();
  return { ...harness, port };
}

const withHandler = {
  notFoundHandler: {
    invoke: { kind: "Test.Handler", name: "missing" },
    inputs: { path: (c: { request: { path: string } }) => c.request.path },
  },
};

/** One GET with the target written exactly as given. */
function send(
  port: number,
  target: string,
  host = "127.0.0.1",
): Promise<{ status: number; contentType: string | undefined; text: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    let raw = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => (raw += chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      const [head = "", ...body] = raw.split("\r\n\r\n");
      const contentType = /^content-type: (.*)$/im.exec(head)?.[1];
      resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(head)![1]), contentType, text: body.join("\r\n\r\n") });
    });
  });
}

async function settled(spans: Array<{ settled: unknown[] }>) {
  for (let i = 0; i < 100 && !(spans.length > 0 && spans.every((s) => s.settled.length > 0)); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const PROBLEM = { type: "about:blank", title: "Not Found", status: 404 };

describe("a path holding an escape that does not decode", () => {
  it("is the bare 404 problem when no not-found handler is declared", async () => {
    const server = await start();
    running = server;
    for (const target of ["/x/%ZZ", "/x/%A", "/x/%E0%A4%A", "/x/%"]) {
      const answer = await send(server.port, target);
      expect(answer.status).toBe(404);
      expect(answer.contentType).toMatch(/^application\/problem\+json/);
      expect(JSON.parse(answer.text)).toEqual(PROBLEM);
      expect(answer.text).not.toContain("FST_ERR_BAD_URL");
    }
  });

  it("invokes the not-found handler, which sees the target as sent", async () => {
    const server = await start(withHandler);
    running = server;
    const answer = await send(server.port, "/x/%ZZ?a=1");
    expect(answer.status).toBe(404);
    expect(JSON.parse(answer.text)).toEqual({ path: "/x/%ZZ?a=1" });
    expect(server.invoked).toEqual(["missing"]);
  });

  it("runs no route handler, even one whose pattern would fit", async () => {
    const server = await start(withHandler);
    running = server;
    const answer = await send(server.port, "/api/items/%ZZ");
    expect(JSON.parse(answer.text)).toEqual({ path: "/api/items/%ZZ" });
    expect(server.invoked).toEqual(["missing"]);
    expect(JSON.parse((await send(server.port, "/api/items/%41")).text)).toEqual({ ok: true });
  });

  it("goes to the not-found handler of its prefix: a spaFallback mount answers with its index", async () => {
    const server = await start();
    running = server;
    const shell = await send(server.port, "/app/%E0%A4%A");
    expect(shell.status).toBe(200);
    expect(shell.text).toBe(INDEX);
    const other = await send(server.port, "/api/%ZZ");
    expect(other.status).toBe(404);
    expect(JSON.parse(other.text)).toEqual(PROBLEM);
  });

  it("passes the request span and the request log record like any request", async () => {
    const server = await start();
    running = server;
    await send(server.port, "/x/%ZZ");
    await settled(server.spans);
    expect(server.spans).toHaveLength(1);
    expect(server.spans[0]!.settled).toEqual([
      { outcome: "ok", attributes: { "http.response.status_code": 404 } },
    ]);
    const completed = server.records.find((r) => r.eventName === "http.server.request");
    expect(completed?.attributes).toMatchObject({ "http.response.status_code": 404 });
    const started = server.records.find((r) => r.eventName === "http.server.request.started");
    expect(started?.attributes).toMatchObject({ "url.path": "/x/%ZZ" });
  });

  it("is refused as any request is under unknownHosts: reject", async () => {
    const server = await start({ unknownHosts: "reject" });
    running = server;
    const refused = await send(server.port, "/x/%ZZ", "evil.example");
    expect(refused.status).toBe(421);
    expect(JSON.parse(refused.text)).toMatchObject({ status: 421, code: "ERR_HOST_NOT_SERVED" });
    expect((await send(server.port, "/x/%ZZ", "shop.example")).status).toBe(404);
  });
});
