import {
  InvokeError,
  NOOP_LOGGER,
  createCancellationSource,
  isCancellationError,
  type CancellationSource,
  type InvokeContext,
} from "@telorun/sdk";
import net, { type AddressInfo, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { create as createApi } from "../src/http-api-controller.js";
import { create as createServer } from "../src/http-server-controller.js";
import { boundedRequestBody } from "../src/request-body-limit.js";

/**
 * A request body is held to `maxBodyBytes` however it is delivered. The counting
 * wrapper is tested alone; everything the server does around it — the 413, the
 * cancellation, the span, what happens to the handler's own outcome — is driven
 * over a socket against the real server and router controllers.
 */

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const CHUNK = new Uint8Array(65536);

describe("boundedRequestBody", () => {
  it("pulls up to the chunk that crosses the limit, delivers nothing past it and releases the source", async () => {
    let pulls = 0;
    let released = false;
    async function* twoGibibytes(): AsyncIterable<Uint8Array> {
      try {
        for (let sent = 0; sent < 2 * GIB; sent += CHUNK.byteLength) {
          pulls += 1;
          yield CHUNK;
        }
      } finally {
        released = true;
      }
    }
    const refusal = new Error("refused");
    let delivered = 0;
    const drained = (async () => {
      for await (const chunk of boundedRequestBody(twoGibibytes(), MIB, () => refusal)) {
        delivered += chunk.byteLength;
      }
    })();
    await expect(drained).rejects.toBe(refusal);
    expect({ pulls, delivered, released }).toEqual({ pulls: 17, delivered: MIB, released: true });
  });
});

type Settled = { outcome: string; attributes?: Record<string, unknown> };

function expandWith(value: unknown, celCtx: Record<string, unknown>): unknown {
  if (typeof value === "function") return value(celCtx);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, expandWith(entry, celCtx)]),
    );
  }
  return value;
}

type Handler = (inputs: { body: AsyncIterable<Uint8Array> }) => unknown;

const handlers: Record<string, Handler> = {
  drain: async ({ body }) => {
    let bytes = 0;
    for await (const chunk of body) bytes += chunk.byteLength;
    return { bytes };
  },
  drainThenThrow: async ({ body }) => {
    try {
      for await (const chunk of body) void chunk;
    } catch {
      throw new InvokeError("ERR_SINK_FAILED", "the sink failed");
    }
    return {};
  },
  drainThenReturn: async ({ body }) => {
    try {
      for await (const chunk of body) void chunk;
    } catch (err) {
      return { swallowed: isCancellationError(err) };
    }
    return {};
  },
  stopEarly: async ({ body }) => {
    for await (const chunk of body) {
      throw new InvokeError("ERR_PART_REFUSED", `refused after ${chunk.byteLength} bytes`);
    }
    return {};
  },
  echo: ({ body }) => ({ output: body }),
  ignore: () => ({}),
  announce: () => ({
    output: (async function* () {
      yield new TextEncoder().encode("first ");
      await new Promise((resolve) => setTimeout(resolve, 20));
      yield new TextEncoder().encode("last");
    })(),
  }),
  readOne: async ({ body }) => {
    const first = await body[Symbol.asyncIterator]().next();
    return { bytes: first.done ? 0 : first.value.byteLength };
  },
  throwFirst: () => {
    throw new InvokeError("ERR_NOT_ACCEPTED", "refused before anything was read");
  },
  json: () => ({}),
};

async function startServer() {
  const settled: Settled[] = [];
  const contexts: InvokeContext[] = [];
  const dispatched: string[] = [];
  const consulted: string[] = [];
  const sockets: Socket[] = [];
  const inverses: Array<() => unknown> = [];
  const chain = (steps: Array<(input: unknown) => Promise<any>>): any => ({
    effect: (reason: string, body: (input: unknown) => Promise<any>) => chain([...steps, body]),
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
  const ctx = {
    log: NOOP_LOGGER,
    effect: (reason: string, body: (input: unknown) => Promise<any>) => chain([body]),
    acquireHold: () => () => {},
    emitEvent: async () => {},
    ensureKindRef: (value: { kind: string; name: string }) => value,
    moduleContext: { expandWith },
    validateSchema: () => {},
    readPlainEncoded: (value: unknown) => value,
    createCancellationSource: () => createCancellationSource(),
    rootContext: (opts?: { cancellation?: CancellationSource }) => opts!.cancellation!.context,
    openSpan: async (base: InvokeContext) => {
      contexts.push(base);
      return {
        context: base,
        settle: async (outcome: string, detail?: { attributes?: Record<string, unknown> }) => {
          settled.push({ outcome, attributes: detail?.attributes });
        },
      };
    },
    invokeResolved: async (kind: string, name: string, instance: unknown, inputs: any) => {
      dispatched.push(name);
      return handlers[name]!(inputs);
    },
  } as never;

  const streamed = { body: { "x-telo-type": "Telo.Stream" } };
  const ok = [{ status: 200, content: { "application/json": {} } }];
  const route = (path: string, handler: string, extra: Record<string, unknown> = {}) => ({
    request: { path, method: "POST", schema: streamed },
    handler: { kind: "Test.Handler", name: handler },
    inputs: { body: (c: { request: { body: unknown } }) => c.request.body },
    returns: ok,
    ...extra,
  });
  const api = await createApi(
    {
      metadata: { name: "uploads" },
      routes: [
        route("/drain", "drain"),
        route("/throws", "drainThenThrow", {
          maxBodyBytes: 1024,
          catches: [
            {
              status: 418,
              content: {
                "application/json": {
                  body: { caught: () => consulted.push("route catch-all") },
                },
              },
            },
          ],
        }),
        route("/returns", "drainThenReturn", { maxBodyBytes: 1024 }),
        route("/stops", "stopEarly", {
          catches: [{ status: 422, content: { "application/json": { body: { refused: true } } } }],
        }),
        route("/echo", "echo", {
          maxBodyBytes: 1024,
          returns: [
            {
              status: 200,
              mode: "stream",
              content: {
                "application/octet-stream": {
                  encoder: { invoke: async ({ input }: { input: unknown }) => ({ output: input }) },
                },
              },
            },
          ],
        }),
        route("/ignores", "ignore"),
        route("/tiny", "ignore", { maxBodyBytes: 1024 }),
        route("/announces", "announce", {
          returns: [
            {
              status: 200,
              mode: "stream",
              content: {
                "application/octet-stream": {
                  encoder: { invoke: async ({ input }: { input: unknown }) => ({ output: input }) },
                },
              },
            },
          ],
        }),
        route("/one", "readOne"),
        {
          request: { path: "/refuses", method: "POST" },
          handler: { kind: "Test.Handler", name: "throwFirst" },
          catches: [{ status: 422, content: { "application/json": { body: { refused: true } } } }],
          returns: ok,
        },
        {
          request: { path: "/json", method: "POST" },
          handler: { kind: "Test.Handler", name: "json" },
          maxBodyBytes: 1024,
          returns: ok,
        },
      ],
    },
    ctx,
  );
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const server = await createServer(
    {
      kind: "Http.Server",
      metadata: { name: "web", module: "test" },
      host: "127.0.0.1",
      port,
      contentTypeParsers: [{ contentType: "application/octet-stream", stream: true }],
      mounts: [{ path: "/", mount: api }],
    } as never,
    ctx,
  );
  await (server!.init!(ctx) as any).perform();
  (server as any).app.server.on("connection", (socket: Socket) => sockets.push(socket));
  await (server!.run!(ctx) as any).perform();
  const unwind = async () => {
    for (const inverse of inverses.reverse()) await inverse();
  };
  return { port, settled, contexts, dispatched, consulted, sockets, unwind };
}

type Answer = {
  status: number | undefined;
  headers: Record<string, string>;
  text: string;
  /** Whether the response was a complete message, or the connection just closed. */
  complete: boolean;
  /** Body bytes the client had handed to its socket when the connection closed. */
  sent: number;
};

/** Uploads over a raw socket, so the client can stop writing when the server
 *  answers early — which `fetch` reports as a failed request. */
function upload(
  port: number,
  options: {
    path: string;
    contentType: string;
    bytes: number;
    chunkBytes?: number;
    declareLength?: boolean;
  },
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let received = Buffer.alloc(0);
    let finished = false;
    let sent = 0;
    socket.on("data", (data) => {
      received = Buffer.concat([received, data]);
    });
    // The server closes on the client while it is still sending.
    socket.on("error", () => {});
    socket.on("close", () => {
      finished = true;
      const [head = "", ...rest] = received.toString("utf8").split("\r\n\r\n");
      const [statusLine = "", ...headerLines] = head.split("\r\n");
      const headers = Object.fromEntries(
        headerLines.map((line) => {
          const at = line.indexOf(":");
          return [line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()];
        }),
      );
      const status = /^HTTP\/1\.1 (\d{3})/.exec(statusLine)?.[1];
      const text = rest.join("\r\n\r\n");
      resolve({
        status: status === undefined ? undefined : Number(status),
        headers,
        text,
        complete:
          headers["content-length"] !== undefined &&
          Buffer.byteLength(text) === Number(headers["content-length"]),
        sent,
      });
    });
    const write = (data: string | Uint8Array) =>
      new Promise<void>((done) => {
        if (finished || socket.destroyed) return done();
        if (socket.write(data)) return done();
        const settle = () => {
          socket.off("drain", settle);
          socket.off("close", settle);
          done();
        };
        socket.once("drain", settle);
        socket.once("close", settle);
      });
    socket.on("connect", async () => {
      try {
        const framing = options.declareLength
          ? `Content-Length: ${options.bytes}`
          : "Transfer-Encoding: chunked";
        await write(
          `POST ${options.path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: ${options.contentType}\r\n${framing}\r\n\r\n`,
        );
        while (sent < options.bytes && received.length === 0 && !finished) {
          const chunk = CHUNK.subarray(
            0,
            Math.min(options.chunkBytes ?? CHUNK.byteLength, options.bytes - sent),
          );
          if (!options.declareLength) await write(`${chunk.byteLength.toString(16)}\r\n`);
          await write(chunk);
          if (!options.declareLength) await write("\r\n");
          sent += chunk.byteLength;
        }
        if (!options.declareLength && received.length === 0) await write("0\r\n\r\n");
      } catch (err) {
        reject(err);
      }
    });
  });
}

let running: { unwind(): Promise<void> } | undefined;
afterEach(async () => {
  await running?.unwind();
  running = undefined;
});

async function settledOnce(settled: Settled[]): Promise<Settled> {
  for (let i = 0; i < 100 && settled.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(settled).toHaveLength(1);
  return settled[0]!;
}

const tooLarge = (maxBodyBytes: number, contentLength?: number) => ({
  error: {
    code: "ERR_REQUEST_BODY_TOO_LARGE",
    message: `Request body exceeds maxBodyBytes (${maxBodyBytes}).`,
    data: { maxBodyBytes, ...(contentLength === undefined ? {} : { contentLength }) },
  },
});

describe("Http.Server request body limit", () => {
  it("a 2 GiB chunked upload to a streamed route: 413 once the limit is crossed, the socket barely read past it", async () => {
    const server = await startServer();
    running = server;
    const answer = await upload(server.port, {
      path: "/drain",
      contentType: "application/octet-stream",
      bytes: 2 * GIB,
    });
    expect(answer.status).toBe(413);
    expect(answer.headers.connection).toBe("close");
    expect(answer.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(JSON.parse(answer.text)).toEqual(tooLarge(MIB));
    expect(server.sockets).toHaveLength(1);
    expect(server.sockets[0]!.bytesRead).toBeLessThanOrEqual(2 * MIB);
    expect(server.contexts[0]!.cancellation.reason).toBe("request-body-too-large");
    expect(await settledOnce(server.settled)).toEqual({
      outcome: "rejected",
      attributes: {
        "http.response.status_code": 413,
        "error.type": "ERR_REQUEST_BODY_TOO_LARGE",
      },
    });
  });

  it("a coded throw from the handler after the overflow reaches no catch list, a route catch-all included", async () => {
    const server = await startServer();
    running = server;
    const answer = await upload(server.port, {
      path: "/throws",
      contentType: "application/octet-stream",
      bytes: 4096,
    });
    expect(server.dispatched).toEqual(["drainThenThrow"]);
    expect(server.consulted).toEqual([]);
    expect(answer.status).toBe(413);
    expect(JSON.parse(answer.text)).toEqual(tooLarge(1024));
  });

  it("a handler that returns after the overflow is not rendered", async () => {
    const server = await startServer();
    running = server;
    const answer = await upload(server.port, {
      path: "/returns",
      contentType: "application/octet-stream",
      bytes: 4096,
    });
    expect(server.dispatched).toEqual(["drainThenReturn"]);
    expect(answer.status).toBe(413);
    expect(JSON.parse(answer.text)).toEqual(tooLarge(1024));
  });

  it("a response already started is cut off instead of answered", async () => {
    const server = await startServer();
    running = server;
    const answer = await upload(server.port, {
      path: "/echo",
      contentType: "application/octet-stream",
      bytes: 4096,
      chunkBytes: 512,
    });
    // The 200 was committed, so no 413 can follow; the connection closes under
    // the response, which never gets its terminating chunk.
    expect([200, undefined]).toContain(answer.status);
    expect(answer.text.endsWith("0\r\n\r\n")).toBe(false);
    expect(await settledOnce(server.settled)).toEqual({
      outcome: "rejected",
      attributes: {
        "http.response.status_code": 200,
        "error.type": "ERR_REQUEST_BODY_TOO_LARGE",
      },
    });
  });

  it("a handler that stops reading before the body ends still answers, and the connection closes behind the unread remainder", async () => {
    const server = await startServer();
    running = server;
    const answer = await upload(server.port, {
      path: "/stops",
      contentType: "application/octet-stream",
      bytes: 512 * 1024,
    });
    expect(answer.status).toBe(422);
    expect(answer.headers.connection).toBe("close");
    expect(JSON.parse(answer.text)).toEqual({ refused: true });
    expect(server.contexts[0]!.cancellation.isCancelled).toBe(false);
  });

  it("a declared length over the limit is refused before the streamed route's handler runs", async () => {
    const server = await startServer();
    running = server;
    const answer = await upload(server.port, {
      path: "/returns",
      contentType: "application/octet-stream",
      bytes: 4096,
      declareLength: true,
    });
    expect(server.dispatched).toEqual([]);
    expect(answer.status).toBe(413);
    expect(answer.headers.connection).toBe("close");
    expect(JSON.parse(answer.text)).toEqual(tooLarge(1024, 4096));
  });

  it("a buffered body draining past the limit is refused before the handler runs", async () => {
    const server = await startServer();
    running = server;
    const answer = await upload(server.port, {
      path: "/json",
      contentType: "text/plain",
      bytes: 4096,
    });
    expect(server.dispatched).toEqual([]);
    expect(answer.status).toBe(413);
    expect(answer.headers.connection).toBe("close");
    expect(answer.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(JSON.parse(answer.text)).toEqual(tooLarge(1024));
    expect(await settledOnce(server.settled)).toEqual({
      outcome: "rejected",
      attributes: {
        "http.response.status_code": 413,
        "error.type": "ERR_REQUEST_BODY_TOO_LARGE",
      },
    });
  });

  /** The most the host may take off a socket it is closing, whatever the body. */
  const DISCARD_CEILING = 8 * MIB;

  async function closedOnce(socket: Socket): Promise<boolean> {
    // The server holds the connection for a second before destroying it.
    for (let i = 0; i < 400 && !socket.destroyed; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return socket.destroyed;
  }

  it("a 64 MiB body the handler never reads: answered, the connection closed and at most a bounded remainder discarded", async () => {
    const server = await startServer();
    running = server;
    const answer = await upload(server.port, {
      path: "/ignores",
      contentType: "application/octet-stream",
      bytes: 64 * MIB,
    });
    expect(server.dispatched).toEqual(["ignore"]);
    expect(answer.status).toBe(200);
    expect(answer.headers.connection).toBe("close");
    expect(answer.sent).toBeLessThan(64 * MIB);
    expect(server.sockets).toHaveLength(1);
    expect(await closedOnce(server.sockets[0]!)).toBe(true);
    expect(server.sockets[0]!.bytesRead).toBeLessThanOrEqual(DISCARD_CEILING);
    expect(server.contexts[0]!.cancellation.reason).toBeUndefined();
  });

  it("a 64 MiB body never read on a route limited to 1 KiB: the connection closed and at most a bounded remainder discarded", async () => {
    const server = await startServer();
    running = server;
    const answer = await upload(server.port, {
      path: "/tiny",
      contentType: "application/octet-stream",
      bytes: 64 * MIB,
    });
    expect(answer.status).toBe(200);
    expect(answer.headers.connection).toBe("close");
    expect(await closedOnce(server.sockets[0]!)).toBe(true);
    expect(server.sockets[0]!.bytesRead).toBeLessThanOrEqual(DISCARD_CEILING);
  });

  it("a streamed response already started over a 64 MiB unread body: it completes, and the connection is closed at its end", async () => {
    const server = await startServer();
    running = server;
    const answer = await upload(server.port, {
      path: "/announces",
      contentType: "application/octet-stream",
      bytes: 64 * MIB,
    });
    expect(answer.status).toBe(200);
    expect(answer.text).toContain("first ");
    expect(answer.text).toContain("last");
    expect(answer.text.endsWith("0\r\n\r\n")).toBe(true);
    expect(answer.sent).toBeLessThan(64 * MIB);
    expect(await closedOnce(server.sockets[0]!)).toBe(true);
    expect(server.sockets[0]!.bytesRead).toBeLessThanOrEqual(DISCARD_CEILING);
  });

  it("a 64 MiB multipart body to a route with no stream body, answered by a catch: the connection closed and at most a bounded remainder discarded", async () => {
    const server = await startServer();
    running = server;
    const answer = await upload(server.port, {
      path: "/refuses",
      contentType: "multipart/form-data; boundary=x",
      bytes: 64 * MIB,
    });
    expect(server.dispatched).toEqual(["throwFirst"]);
    expect(answer.status).toBe(422);
    expect(answer.headers.connection).toBe("close");
    expect(JSON.parse(answer.text)).toEqual({ refused: true });
    expect(await closedOnce(server.sockets[0]!)).toBe(true);
    expect(server.sockets[0]!.bytesRead).toBeLessThanOrEqual(DISCARD_CEILING);
  });

  it("a handler that reads one chunk of a 64 MiB body and returns: the connection closed and at most a bounded remainder discarded", async () => {
    const server = await startServer();
    running = server;
    const answer = await upload(server.port, {
      path: "/one",
      contentType: "application/octet-stream",
      bytes: 64 * MIB,
    });
    expect(answer.status).toBe(200);
    expect(answer.headers.connection).toBe("close");
    expect(answer.sent).toBeLessThan(64 * MIB);
    expect(await closedOnce(server.sockets[0]!)).toBe(true);
    expect(server.sockets[0]!.bytesRead).toBeLessThanOrEqual(DISCARD_CEILING);
  });

  it("a body that arrived whole and was never read keeps the connection for the next request", async () => {
    const server = await startServer();
    running = server;
    const request =
      "POST /ignores HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/octet-stream\r\n" +
      `Content-Length: 1024\r\n\r\n${"a".repeat(1024)}`;
    const socket = net.connect({ host: "127.0.0.1", port: server.port });
    let received = "";
    socket.on("data", (data) => {
      received += data.toString("utf8");
    });
    const responses = async (count: number) => {
      for (let i = 0; i < 200 && received.split("HTTP/1.1 ").length - 1 < count; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return received.split("HTTP/1.1 ").slice(1);
    };
    try {
      await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
      socket.write(request);
      const [first] = await responses(1);
      expect(first).toMatch(/^200 /);
      expect(first!.toLowerCase()).not.toContain("connection: close");
      socket.write(request);
      const answers = await responses(2);
      expect(answers).toHaveLength(2);
      expect(answers[1]).toMatch(/^200 /);
      expect(server.dispatched).toEqual(["ignore", "ignore"]);
    } finally {
      socket.destroy();
    }
  });
});
