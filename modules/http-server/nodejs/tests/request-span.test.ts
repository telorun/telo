import {
  ERR_INVOKE_CANCELLED,
  InvokeError,
  NOOP_LOGGER,
  createCancellationSource,
  type CancellationSource,
  type InvokeContext,
} from "@telorun/sdk";
import net, { type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { create as createApi } from "../src/http-api-controller.js";
import { create as createServer } from "../src/http-server-controller.js";

/**
 * `Http.Server` opens exactly one span per request, before CORS, a mount's guard
 * and body parsing, and settles it when the response completes. Every dispatch
 * the request drives — the guard, the route handler, the not-found handler —
 * receives the span's context, and a client disconnect cancels it. This drives
 * the real server controller over a socket with a context that records
 * `openSpan`; the span mechanics themselves are the kernel's, tested there.
 */

type SpanCall = {
  opts: Record<string, unknown>;
  context: InvokeContext;
  settled: Array<{ outcome: string; attributes?: Record<string, unknown> }>;
};

type Dispatch = { name: string; context: InvokeContext };

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** `expandWith` evaluates a function-valued entry against the CEL context, which
 *  is how these fixtures stand in for `!cel` expressions. */
function expandWith(value: unknown, celCtx: Record<string, unknown>): unknown {
  if (typeof value === "function") return value(celCtx);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, expandWith(entry, celCtx)]),
    );
  }
  return value;
}

function testContext(behaviours: Record<string, (inputs: any, context: InvokeContext) => unknown>) {
  const spans: SpanCall[] = [];
  const dispatches: Dispatch[] = [];
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
  const dispatch = async (name: string, inputs: unknown, context: InvokeContext) => {
    dispatches.push({ name, context });
    return behaviours[name]!(inputs, context);
  };
  const ctx = {
    log: NOOP_LOGGER,
    effect: (_reason: string, body: (input: unknown) => Promise<any>) => chain([body]),
    acquireHold: () => () => {},
    emitEvent: async () => {},
    ensureKindRef: (value: { kind: string; name: string }) => value,
    moduleContext: { expandWith },
    validateSchema: () => {},
    readPlainEncoded: (value: unknown) => value,
    createCancellationSource: () => createCancellationSource(),
    rootContext: (opts?: { cancellation?: CancellationSource }) => opts!.cancellation!.context,
    openSpan: async (base: InvokeContext, opts: Record<string, unknown>) => {
      const call: SpanCall = { opts, context: { ...base, invocationId: spans.length + 1 }, settled: [] };
      spans.push(call);
      return {
        context: call.context,
        settle: async (outcome: string, detail?: { attributes?: Record<string, unknown> }) => {
          call.settled.push({ outcome, attributes: detail?.attributes });
        },
      };
    },
    invoke: (_kind: string, name: string, inputs: unknown, options: { ctx: InvokeContext }) =>
      dispatch(name, inputs, options.ctx),
    invokeResolved: (
      _kind: string,
      name: string,
      _instance: unknown,
      inputs: unknown,
      context: InvokeContext,
    ) => dispatch(name, inputs, context),
  };
  const unwind = async () => {
    for (const inverse of inverses.reverse()) await inverse();
  };
  return { ctx: ctx as never, spans, dispatches, unwind };
}

const behaviours = {
  auth: (inputs: { authorization?: string }) => {
    if (inputs.authorization !== "Bearer ok") {
      throw new InvokeError("ERR_UNAUTHENTICATED", "missing credential");
    }
    return {};
  },
  items: () => ({ items: [] }),
  ready: () => ({ ready: true }),
  boom: () => {
    throw new Error("uncoded failure");
  },
  missing: () => ({ status: 404, body: { error: "not here" } }),
  slow: (_inputs: unknown, context: InvokeContext) =>
    new Promise((_resolve, reject) => {
      context.cancellation.onCancelled(() =>
        reject(new InvokeError(ERR_INVOKE_CANCELLED, "client went away")),
      );
    }),
};

const ok = [{ status: 200, content: { "application/json": { body: { ok: true } } } }];

async function startServer(options: { notFoundHandler: boolean }) {
  const harness = testContext(behaviours);
  const route = (path: string, handler: string, extra: Record<string, unknown> = {}) => ({
    request: { path, method: "GET", ...extra },
    handler: { kind: "Test.Handler", name: handler },
    returns: ok,
  });
  const guarded = await createApi(
    {
      metadata: { name: "guarded" },
      routes: [
        route("/items", "items"),
        route("/slow", "slow"),
        route("/boom", "boom"),
        route("/search", "items", {
          schema: {
            query: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
          },
        }),
      ],
    },
    harness.ctx,
  );
  const unguarded = await createApi(
    { metadata: { name: "probes" }, routes: [route("/ready", "ready")] },
    harness.ctx,
  );
  const port = await freePort();
  const server = await createServer(
    {
      kind: "Http.Server",
      metadata: { name: "web", module: "test" },
      host: "127.0.0.1",
      port,
      cors: { origin: "*" },
      mounts: [
        {
          path: "/api",
          mount: guarded,
          guard: {
            invoke: { kind: "Test.Guard", name: "auth" },
            inputs: {
              authorization: (c: { request: { headers: Record<string, string> } }) =>
                c.request.headers.authorization,
            },
            catches: [{ status: 401, when: true, headers: { "WWW-Authenticate": "Bearer" } }],
          },
        },
        { path: "/probes", mount: unguarded },
      ],
      ...(options.notFoundHandler
        ? { notFoundHandler: { invoke: { kind: "Test.Handler", name: "missing" } } }
        : {}),
    } as never,
    harness.ctx,
  );
  await (server!.init!(harness.ctx as never) as any).perform();
  await (server!.run!(harness.ctx as never) as any).perform();
  return { ...harness, url: `http://127.0.0.1:${port}`, port };
}

let running: { unwind(): Promise<void> } | undefined;
afterEach(async () => {
  await running?.unwind();
  running = undefined;
});

async function settledSpan(spans: SpanCall[]): Promise<SpanCall> {
  for (let i = 0; i < 100 && !spans.every((span) => span.settled.length > 0); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(spans).toHaveLength(1);
  const [span] = spans;
  expect(span!.opts.ref).toEqual({ kind: "Http.Server", name: "web" });
  expect(span!.settled).toHaveLength(1);
  return span!;
}

describe("Http.Server request span", () => {
  it("guarded, allowed: guard and handler run on the span, which continues the traceparent", async () => {
    const server = await startServer({ notFoundHandler: false });
    running = server;
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const response = await fetch(`${server.url}/api/items`, {
      headers: { authorization: "Bearer ok", traceparent, tracestate: "vendor=1" },
    });
    expect(response.status).toBe(200);
    const span = await settledSpan(server.spans);
    expect(span.opts).toMatchObject({
      label: "GET /api/items",
      attributes: { "http.request.method": "GET", "http.route": "/api/items" },
      inbound: { traceparent, tracestate: "vendor=1" },
    });
    expect(server.dispatches.map((d) => d.name)).toEqual(["auth", "items"]);
    for (const dispatch of server.dispatches) expect(dispatch.context).toBe(span.context);
    expect(span.settled).toEqual([
      { outcome: "ok", attributes: { "http.response.status_code": 200 } },
    ]);
  });

  it("guarded, refused: the guard's coded refusal decides the span, no handler runs", async () => {
    const server = await startServer({ notFoundHandler: false });
    running = server;
    const response = await fetch(`${server.url}/api/items`);
    expect(response.status).toBe(401);
    const span = await settledSpan(server.spans);
    expect(span.opts).not.toHaveProperty("inbound");
    expect(server.dispatches.map((d) => d.name)).toEqual(["auth"]);
    expect(server.dispatches[0]!.context).toBe(span.context);
    expect(span.settled).toEqual([
      {
        outcome: "rejected",
        attributes: { "http.response.status_code": 401, "error.type": "ERR_UNAUTHENTICATED" },
      },
    ]);
  });

  it("unguarded: the handler runs on the span", async () => {
    const server = await startServer({ notFoundHandler: false });
    running = server;
    expect((await fetch(`${server.url}/probes/ready`)).status).toBe(200);
    const span = await settledSpan(server.spans);
    expect(span.opts).toMatchObject({
      label: "GET /probes/ready",
      attributes: { "http.request.method": "GET", "http.route": "/probes/ready" },
    });
    expect(server.dispatches.map((d) => d.name)).toEqual(["ready"]);
    expect(server.dispatches[0]!.context).toBe(span.context);
    expect(span.settled).toEqual([
      { outcome: "ok", attributes: { "http.response.status_code": 200 } },
    ]);
  });

  it("not found with a handler: named by the method alone, the handler runs on the span", async () => {
    const server = await startServer({ notFoundHandler: true });
    running = server;
    expect((await fetch(`${server.url}/nowhere`)).status).toBe(404);
    const span = await settledSpan(server.spans);
    expect(span.opts).toMatchObject({ label: "GET", attributes: { "http.request.method": "GET" } });
    expect(span.opts.attributes).not.toHaveProperty("http.route");
    expect(server.dispatches.map((d) => d.name)).toEqual(["missing"]);
    expect(server.dispatches[0]!.context).toBe(span.context);
    expect(span.settled).toEqual([
      { outcome: "ok", attributes: { "http.response.status_code": 404 } },
    ]);
  });

  it("not found without a handler: a span of its own, ok", async () => {
    const server = await startServer({ notFoundHandler: false });
    running = server;
    expect((await fetch(`${server.url}/nowhere`)).status).toBe(404);
    const span = await settledSpan(server.spans);
    expect(span.opts).toMatchObject({ label: "GET" });
    expect(server.dispatches).toEqual([]);
    expect(span.settled).toEqual([
      { outcome: "ok", attributes: { "http.response.status_code": 404 } },
    ]);
  });

  it("CORS preflight: one span, answered before any guard", async () => {
    const server = await startServer({ notFoundHandler: false });
    running = server;
    const response = await fetch(`${server.url}/api/items`, {
      method: "OPTIONS",
      headers: { origin: "http://example.test", "access-control-request-method": "GET" },
    });
    expect(response.status).toBe(204);
    const span = await settledSpan(server.spans);
    expect(span.opts).toMatchObject({ attributes: { "http.request.method": "OPTIONS" } });
    expect(server.dispatches).toEqual([]);
    expect(span.settled).toEqual([
      { outcome: "ok", attributes: { "http.response.status_code": 204 } },
    ]);
  });

  it("request validation: a 400 is rejected with ERR_INPUT_INVALID", async () => {
    const server = await startServer({ notFoundHandler: false });
    running = server;
    const response = await fetch(`${server.url}/api/search`, {
      headers: { authorization: "Bearer ok" },
    });
    expect(response.status).toBe(400);
    const span = await settledSpan(server.spans);
    expect(span.settled).toEqual([
      {
        outcome: "rejected",
        attributes: { "http.response.status_code": 400, "error.type": "ERR_INPUT_INVALID" },
      },
    ]);
  });

  it("uncoded error: the framework's 500 fails the span", async () => {
    const server = await startServer({ notFoundHandler: false });
    running = server;
    const response = await fetch(`${server.url}/api/boom`, {
      headers: { authorization: "Bearer ok" },
    });
    expect(response.status).toBe(500);
    const span = await settledSpan(server.spans);
    expect(span.settled).toEqual([
      {
        outcome: "failed",
        attributes: { "http.response.status_code": 500, "error.type": "Error" },
      },
    ]);
  });

  it("client disconnect: the span's context is cancelled and the span ends cancelled", async () => {
    const server = await startServer({ notFoundHandler: false });
    running = server;
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port: server.port });
      socket.on("error", reject);
      socket.on("connect", () => {
        socket.write(
          `GET /api/slow HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ok\r\n\r\n`,
        );
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 200);
      });
    });
    const span = await settledSpan(server.spans);
    expect(server.dispatches.map((d) => d.name)).toEqual(["auth", "slow"]);
    for (const dispatch of server.dispatches) expect(dispatch.context).toBe(span.context);
    expect(span.context.cancellation.isCancelled).toBe(true);
    expect(span.context.cancellation.reason).toBe("client-disconnect");
    expect(span.settled).toEqual([{ outcome: "cancelled", attributes: {} }]);
  });
});
