/**
 * Transport-neutral response sink. HTTP-shaped transports (Fastify-backed
 * http-server, AWS Lambda, future fetch-API / native http.Server adapters)
 * implement this interface; the dispatcher (`dispatchReturns` /
 * `dispatchCatches`) writes through it without knowing which transport is
 * underneath.
 *
 * Semantics:
 * - `setStatus` and `setHeader` are synchronous accumulators. The sink does
 *   not flush headers until `send` or `stream` is called.
 * - `setHeader` is last-write-wins: a second call for the same name replaces
 *   the previous value (no multi-value merging).
 * - `Content-Type` is set via `setHeader("Content-Type", mime)` like any other
 *   header — no special-case parameter.
 * - `send(body?)` flushes status + headers and ends the response. The body is
 *   passed as-is (`unknown`); each sink is responsible for serializing it per
 *   the accumulated `Content-Type`.
 * - `stream(iter, onError?)` flushes status + headers, then streams the
 *   already-encoded `AsyncIterable<Uint8Array>` to the transport. Mid-stream
 *   failures (after headers flush) are reported via `onError`; the response
 *   cannot be re-routed at that point.
 * - Both `send` and `stream` end the response — there is no explicit commit
 *   phase. Calling either method twice on the same sink is an error.
 * - Adapters reject from `send` / `stream` only on transport-fatal errors
 *   (e.g. client socket closed before flush in buffer mode). Mid-stream
 *   failures go through `onError`, not the returned promise.
 */
export interface ResponseSink {
  setStatus(code: number): void;
  setHeader(name: string, value: string): void;
  send(body?: unknown): Promise<void>;
  stream(
    iter: AsyncIterable<Uint8Array>,
    onError?: (err: unknown) => void | Promise<void>,
  ): Promise<void>;
}

/**
 * Hook invoked when a stream rejects *after* headers have been flushed — at
 * that point the response is committed and `catches:` cannot fire. Surfacing
 * the failure here lets the http-server adapter emit `Http.Api.streamFailed`,
 * and Lambda route it to CloudWatch.
 *
 * The dispatcher closes over `entry.status` / `matchedMime` at the call site
 * and builds a per-event callback with that context baked in, rather than
 * the sink interface carrying `{status, mime}` parameters it doesn't
 * otherwise care about.
 */
export type StreamErrorHook = (
  err: unknown,
  ctx: { status: number; mime: string },
) => Promise<void> | void;
