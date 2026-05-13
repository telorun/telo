import type { ResponseSink } from "@telorun/http-dispatch";
import type { FastifyReply } from "fastify";
import type { OutgoingHttpHeaders } from "http";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

/** Adapts a Fastify `FastifyReply` to the transport-neutral `ResponseSink`
 *  interface from `@telorun/http-dispatch`. Status / header accumulation maps
 *  directly onto Fastify's setters; buffered bodies go through
 *  `reply.send(body)` (so Fastify's per-status fast-json-stringify dispatch
 *  still runs); streamed bodies hijack the reply and pipe through `reply.raw`.
 *
 *  The sink owns the rule that `setStatus` / `setHeader` calls after the
 *  response is committed must throw — Fastify itself would silently no-op
 *  in some cases, so we enforce the contract here. */
export function fastifyReplySink(reply: FastifyReply): ResponseSink {
  let status = 200;
  let sent = false;

  function ensureOpen(method: string): void {
    if (sent) {
      throw new Error(`fastifyReplySink: ${method} called after response was sent`);
    }
  }

  return {
    setStatus(code) {
      ensureOpen("setStatus");
      status = code;
      reply.code(code);
    },
    setHeader(name, value) {
      ensureOpen("setHeader");
      // Fastify's reply.header is last-write-wins for the same name.
      reply.header(name, value);
    },
    async send(body) {
      ensureOpen("send");
      sent = true;
      if (body === undefined) {
        reply.send();
      } else {
        reply.send(body);
      }
    },
    async stream(iter, onError) {
      ensureOpen("stream");
      sent = true;
      reply.hijack();
      reply.raw.writeHead(status, reply.getHeaders() as OutgoingHttpHeaders);
      try {
        await pipeline(Readable.from(iter), reply.raw);
      } catch (err) {
        if (onError) {
          try {
            await onError(err);
          } catch {
            /* operator hook should never fail the response — swallow */
          }
        }
        // Headers are flushed at this point; the response is committed and
        // there's nothing useful to rethrow into Fastify. The socket will
        // close.
      }
    },
  };
}
