import type { InvokeContext } from "@telorun/sdk";

/**
 * What an HTTP transport hands every mount it registers, as the third argument of
 * `register(app, prefix, requestScope)`: the transport opens one span per request
 * before anything runs for it, and a mount dispatches the request's work on it.
 *
 * `TRequest` is the transport's own request object (a Fastify request for
 * `Http.Server`), so the scope is looked up by the value the mount already holds.
 */
export interface RequestScope<TRequest> {
  /** The scope of a request the transport is serving. Throws for a request the
   *  transport did not open, which is a transport defect rather than a miss. */
  forRequest(request: TRequest): RequestTrace;
}

/** One request's unit of work. */
export interface RequestTrace {
  /** The request span's context, carrying the request's cancellation (a client
   *  disconnect cancels it). Every dispatch the request drives runs on it. */
  readonly context: InvokeContext;
  /** Report the error that decided the response, when the mount renders it
   *  itself (a `catches:` rung, a request-validation refusal). An error the mount
   *  rethrows reaches the transport, which reports it. */
  reject(error: unknown): void;
}
