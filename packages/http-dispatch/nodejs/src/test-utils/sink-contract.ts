import { describe, expect, it } from "vitest";
import type { ResponseSink } from "../sink.js";

/**
 * A captured response from a `ResponseSink`. Each adapter's test harness
 * returns one of these so the contract suite can assert on observable
 * outputs without coupling to the underlying transport.
 */
export interface CapturedResponse {
  status: number;
  /** Lowercased header keys → value. Last-write-wins is enforced. */
  headers: Record<string, string>;
  /** Raw response bytes. For buffered responses, parse via the captured
   *  `Content-Type`; for streamed responses, compare byte-exact. */
  body: Uint8Array;
  /** Whether the sink emitted bytes via `stream(...)` rather than `send(...)`. */
  isStream: boolean;
}

export interface SinkHandle {
  sink: ResponseSink;
  /** Resolves once the sink's `send` / `stream` flush completes (or rejects
   *  with a transport-fatal error). */
  result: Promise<CapturedResponse>;
}

/** Each test case creates a fresh sink + a future capturing the resulting
 *  response. Adapter implementations should ensure the returned promise
 *  rejects only on transport-fatal errors (not on mid-stream failures —
 *  those route through the `onError` callback). */
export type SinkFactory = () => SinkHandle;

/** Concatenate an `AsyncIterable<Uint8Array>` into a single `Uint8Array`. */
async function collectBytes(iter: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of iter) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Builds an `AsyncIterable<Uint8Array>` from a list of chunks. */
async function* fromChunks(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

/** An async iterable that yields one chunk, then throws on the next pull.
 *  Used by the contract suite to exercise the post-headers stream-failure
 *  path. */
async function* failingStream(firstChunk: Uint8Array, err: Error): AsyncIterable<Uint8Array> {
  yield firstChunk;
  throw err;
}

/**
 * The shared sink contract. Every `ResponseSink` implementation (the in-memory
 * sink used by the dispatcher's own tests, `fastifyReplySink` in
 * `@telorun/http-server`, the Lambda sink in `@telorun/lambda`, …) imports
 * this and runs its own factory through it. Drift between transports
 * surfaces here, not in a transport-specific bug discovered downstream.
 *
 * Buffered-body assertions parse the bytes as JSON before comparison —
 * Fastify's fast-json-stringify and the Lambda sink's `JSON.stringify`
 * legitimately differ on whitespace / key order. Streamed-body assertions
 * are byte-exact (the dispatcher hands the sink an already-encoded
 * `AsyncIterable<Uint8Array>`).
 */
export function runSinkContract(name: string, makeSink: SinkFactory): void {
  describe(name, () => {
    it("renders a status-only response with no body", async () => {
      const { sink, result } = makeSink();
      sink.setStatus(204);
      await sink.send();
      const captured = await result;
      expect(captured.status).toBe(204);
      expect(captured.body.byteLength).toBe(0);
      expect(captured.isStream).toBe(false);
    });

    it("renders status + headers + buffered JSON body", async () => {
      const { sink, result } = makeSink();
      sink.setStatus(200);
      sink.setHeader("Content-Type", "application/json");
      sink.setHeader("X-Trace-Id", "abc-123");
      await sink.send({ ok: true, count: 42 });
      const captured = await result;
      expect(captured.status).toBe(200);
      expect(captured.headers["content-type"]).toMatch(/^application\/json/);
      expect(captured.headers["x-trace-id"]).toBe("abc-123");
      expect(JSON.parse(new TextDecoder().decode(captured.body))).toEqual({
        ok: true,
        count: 42,
      });
      expect(captured.isStream).toBe(false);
    });

    it("setHeader is last-write-wins (no multi-value merging)", async () => {
      // The dispatcher relies on this for `dispatchCatches` overriding the
      // negotiated Content-Type back to application/json when no body: was
      // provided — must replace the prior value, not append.
      const { sink, result } = makeSink();
      sink.setStatus(200);
      sink.setHeader("Content-Type", "text/plain");
      sink.setHeader("Content-Type", "application/json");
      await sink.send({ replaced: true });
      const captured = await result;
      expect(captured.headers["content-type"]).toMatch(/^application\/json/);
      expect(captured.headers["content-type"]).not.toMatch(/text\/plain/);
    });

    it("streams already-encoded bytes through `stream(iter)`", async () => {
      const { sink, result } = makeSink();
      sink.setStatus(200);
      sink.setHeader("Content-Type", "text/event-stream");
      const chunks = [
        new TextEncoder().encode("data: a\n\n"),
        new TextEncoder().encode("data: b\n\n"),
        new TextEncoder().encode("data: c\n\n"),
      ];
      await sink.stream(fromChunks(chunks));
      const captured = await result;
      expect(captured.status).toBe(200);
      expect(captured.headers["content-type"]).toBe("text/event-stream");
      // Byte-exact assertion: the encoder has already produced the wire bytes,
      // so the sink must not re-encode or transform them.
      const expected = await collectBytes(fromChunks(chunks));
      expect(captured.body).toEqual(expected);
      expect(captured.isStream).toBe(true);
    });

    it("invokes onError after headers flush when the stream rejects mid-flight", async () => {
      const { sink, result } = makeSink();
      sink.setStatus(200);
      sink.setHeader("Content-Type", "text/event-stream");
      const failure = new Error("upstream encoder threw");
      let observed: unknown;
      await sink.stream(
        failingStream(new TextEncoder().encode("data: first\n\n"), failure),
        (err) => {
          observed = err;
        },
      );
      const captured = await result;
      expect(observed).toBe(failure);
      // The response is committed once headers flush — at least one chunk
      // must have made it to the wire.
      expect(captured.body.byteLength).toBeGreaterThan(0);
      expect(captured.isStream).toBe(true);
    });

    it("rejects a second send() call on the same sink", async () => {
      const { sink, result } = makeSink();
      sink.setStatus(200);
      sink.setHeader("Content-Type", "application/json");
      await sink.send({ first: true });
      await expect(sink.send({ second: true })).rejects.toBeInstanceOf(Error);
      // Drain the captured response to avoid an unhandled rejection in
      // adapters that wire `result` to the transport's lifetime.
      await result;
    });

    it("rejects setStatus() after send()", async () => {
      const { sink, result } = makeSink();
      sink.setStatus(200);
      sink.setHeader("Content-Type", "application/json");
      await sink.send({ first: true });
      expect(() => sink.setStatus(500)).toThrow();
      await result;
    });
  });
}
