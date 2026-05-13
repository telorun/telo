import { runSinkContract, type SinkHandle } from "@telorun/http-dispatch/test-utils";
import type { CapturedResponse } from "@telorun/http-dispatch/test-utils";
import type { ResponseSink } from "@telorun/http-dispatch";
import Fastify from "fastify";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fastifyReplySink } from "../src/fastify-reply-sink.js";

/** Drives `fastifyReplySink` through the shared `runSinkContract` harness so
 *  the production Fastify adapter is held to the same status / header / send /
 *  stream contract as every other transport adapter.
 *
 *  The harness expects `setStatus`/`setHeader` to be callable synchronously the
 *  moment `makeSink()` returns, but Fastify only hands a real `FastifyReply`
 *  to a handler after a request lands. The wrapper queues sync calls until
 *  the route handler runs, then replays them against the real sink — async
 *  calls (`send` / `stream`) wire their returned promise to the real
 *  operation's outcome so awaiting code sees the correct success/failure.
 *
 *  Uses a real listening server (not `app.inject`): light-my-request rejects
 *  on the destroyed-stream path that mid-flight errors take, which would
 *  hide whether the partial body actually made it to the wire — exactly the
 *  thing the contract's stream-failure case asserts. */
function makeFastifySink(): SinkHandle {
  type Op = (real: ResponseSink) => void | Promise<void>;
  const queue: Op[] = [];
  let real: ResponseSink | undefined;
  let usedStream = false;

  let resolveResult!: (r: CapturedResponse) => void;
  let rejectResult!: (e: unknown) => void;
  const result = new Promise<CapturedResponse>((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });

  async function flush(target: ResponseSink): Promise<void> {
    while (queue.length > 0) {
      const op = queue.shift()!;
      await op(target);
    }
  }

  const sink: ResponseSink = {
    setStatus(code) {
      if (real) {
        real.setStatus(code);
        return;
      }
      queue.push((s) => s.setStatus(code));
    },
    setHeader(name, value) {
      if (real) {
        real.setHeader(name, value);
        return;
      }
      queue.push((s) => s.setHeader(name, value));
    },
    async send(body) {
      if (real) {
        await real.send(body);
        return;
      }
      await new Promise<void>((res, rej) => {
        queue.push(async (s) => {
          try {
            await s.send(body);
            res();
          } catch (e) {
            rej(e);
          }
        });
      });
    },
    async stream(iter, onError) {
      usedStream = true;
      if (real) {
        await real.stream(iter, onError);
        return;
      }
      await new Promise<void>((res, rej) => {
        queue.push(async (s) => {
          try {
            await s.stream(iter, onError);
            res();
          } catch (e) {
            rej(e);
          }
        });
      });
    },
  };

  const app = Fastify();
  app.route({
    method: "POST",
    url: "/",
    handler: async (_req, reply) => {
      real = fastifyReplySink(reply);
      await flush(real);
    },
  });

  void (async () => {
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const addr = app.server.address() as AddressInfo;
      await new Promise<void>((settle) => {
        let settled = false;
        const finish = (build: () => CapturedResponse) => {
          if (settled) return;
          settled = true;
          try {
            resolveResult(build());
          } catch (e) {
            rejectResult(e);
          }
          settle();
        };

        const req = http.request({
          host: addr.address,
          port: addr.port,
          path: "/",
          method: "POST",
        });
        req.on("error", (e) => {
          if (settled) return;
          settled = true;
          rejectResult(e);
          settle();
        });
        req.on("response", (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c as Buffer));
          // Both `end` (clean) and `close`/`aborted` (mid-stream destroy) end
          // the response from the client's perspective. The contract treats
          // both as terminal: whatever bytes arrived are the captured body,
          // and `onError` (if provided) was already invoked on the server.
          const buildCaptured = (): CapturedResponse => {
            let total = 0;
            for (const c of chunks) total += c.byteLength;
            const body = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) {
              body.set(c, off);
              off += c.byteLength;
            }
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
              if (v == null) continue;
              headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
            }
            return {
              status: res.statusCode ?? 0,
              headers,
              body,
              isStream: usedStream,
            };
          };
          res.on("end", () => finish(buildCaptured));
          res.on("close", () => finish(buildCaptured));
          res.on("aborted", () => finish(buildCaptured));
        });
        req.end();
      });
    } catch (e) {
      rejectResult(e);
    } finally {
      await app.close().catch(() => {
        /* server close after partial-response abort can race; harmless */
      });
    }
  })();

  return { sink, result };
}

runSinkContract("fastifyReplySink", makeFastifySink);
