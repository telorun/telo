import { errorEnvelope } from "@telorun/http-dispatch";
import { ERR_INVOKE_CANCELLED, InvokeError, type InvokeContext } from "@telorun/sdk";
import type { IncomingMessage } from "node:http";

/** Fastify's own default, restated so the limit is this kind's declaration. */
export const DEFAULT_MAX_BODY_BYTES = 1048576;

export const ERR_REQUEST_BODY_TOO_LARGE = "ERR_REQUEST_BODY_TOO_LARGE";

/** The reason a request's invocation is cancelled with when its streamed body
 *  crosses the limit. */
export const REQUEST_BODY_TOO_LARGE_REASON = "request-body-too-large";

/** Raised by a raw body parser for a declared length over the limit. Uncoded on
 *  purpose: the server answers it itself, and no `catches:` list keys on it. */
export class RequestBodyOverLimit extends Error {
  constructor() {
    super("Request body is larger than the limit");
    this.name = "RequestBodyOverLimit";
  }
}

/** Both spellings of "the body is over the limit": this module's raw parsers and
 *  Fastify's buffered ones. */
export function isRequestBodyOverLimit(error: unknown): boolean {
  return (
    error instanceof RequestBodyOverLimit ||
    (error as { code?: unknown } | null)?.code === "FST_ERR_CTP_BODY_TOO_LARGE"
  );
}

/** The refusal as it is reported on the request span and rendered in the 413. */
export function requestBodyTooLarge(maxBodyBytes: number, contentLength?: number): InvokeError {
  return new InvokeError(
    ERR_REQUEST_BODY_TOO_LARGE,
    `Request body exceeds maxBodyBytes (${maxBodyBytes}).`,
    { maxBodyBytes, ...(contentLength === undefined ? {} : { contentLength }) },
  );
}

export function requestBodyTooLargeEnvelope(refusal: InvokeError) {
  return errorEnvelope({ code: refusal.code, message: refusal.message, data: refusal.data });
}

/** The cancellation a streamed body fails with once the server has refused it. */
export function requestBodyCancellation(): InvokeError {
  return new InvokeError(ERR_INVOKE_CANCELLED, REQUEST_BODY_TOO_LARGE_REASON);
}

/** Whether the server already answered this request for its body's size, so
 *  nothing its handler returns or throws is rendered. */
export function requestBodyRefused(context: InvokeContext): boolean {
  return (
    context.cancellation.isCancelled &&
    context.cancellation.reason === REQUEST_BODY_TOO_LARGE_REASON
  );
}

/** A Content-Length that states a size; absent for a chunked body. */
export function declaredContentLength(header: string | string[] | undefined): number | undefined {
  if (typeof header !== "string") return undefined;
  const length = Number(header);
  return Number.isSafeInteger(length) && length >= 0 ? length : undefined;
}

/**
 * Whether the request's body is known to have reached the server in full:
 * `pulled` is what was already handed on of it. A host reports completion only
 * after the turn that parsed the last byte, so a declared length is also
 * compared with what has been parsed; a chunked body counts once its end was
 * seen.
 */
export function requestBodyArrived(request: IncomingMessage, pulled: number): boolean {
  if (request.complete || request.readableEnded) return true;
  if (request.headers["transfer-encoding"] !== undefined) return false;
  const length = declaredContentLength(request.headers["content-length"]);
  return length === undefined || pulled + request.readableLength >= length;
}

/**
 * A body counted as it is pulled. The chunk that takes the total past
 * `maxBodyBytes` is never delivered: `refuse` runs, the source is released and
 * the read fails with what `refuse` returned.
 */
export async function* boundedRequestBody(
  source: AsyncIterable<Uint8Array>,
  maxBodyBytes: number,
  refuse: () => Error,
): AsyncIterable<Uint8Array> {
  let pulled = 0;
  for await (const chunk of source) {
    pulled += chunk.byteLength;
    if (pulled > maxBodyBytes) throw refuse();
    yield chunk;
  }
}
