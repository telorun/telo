import { modelFailureFromError, modelInvalidReference, modelResponseInvalid } from "@telorun/ai";
import { integerInput, type InvokeContext, type InvokeError } from "@telorun/sdk";
import {
  answerUnreadable,
  reportedFailure,
  requestRejection,
  requestUnbuilt,
  responseFailure,
  vendorErrorOf,
} from "./anthropic-failure.js";

/**
 * The endpoint seam: every call goes through an injected `Http.Request`, whose
 * client carries the base URL and the `x-api-key` credential. This module holds
 * no key.
 *
 * THE TRANSPORT CARRIES BYTES; THIS MODULE DECODES. A call asks for the body
 * undecoded, never as parsed JSON: the wire dialect is this module's, so
 * reading it — and the code a body that cannot be read is raised under — is
 * too. An author's `success:` / `retryOn:` rule on a request handed to a model
 * kind therefore sees `body` as undecoded text.
 *
 * EVERY ERROR OF A CALL LEAVES THROUGH ONE BOUNDARY, `modelFailureFromError`,
 * which passes what is not a model failure and asks this module about the rest.
 * The answer depends on how far the call got: until a success response is in
 * hand it is a request that was not served, and from then on an answer that
 * could not be read. {@link building}, {@link reading} and
 * {@link readingParts} are that boundary for the code a model kind runs itself.
 */

/** The dialect the translation is written against, sent on every call. */
export const ANTHROPIC_VERSION = "2023-06-01";

/** Relative to the client's base URL (`https://api.anthropic.com/v1`). */
export const MESSAGES_PATH = "/messages";

/** What Phase-5 injection leaves in the `request` slot. */
export interface HttpRequestInstance {
  invoke(inputs: Record<string, unknown>, ctx?: InvokeContext): Promise<MessagesResponse>;
}

export interface MessagesResponse {
  /** A number, or the int64 a declared-integer output crosses a dispatch as. */
  status: number | bigint;
  headers: Record<string, string>;
  body: unknown;
}

export interface MessagesCall {
  body: Record<string, unknown>;
  /** The opt-in features of this call, sent as `anthropic-beta`. */
  betas?: string[];
}

/** `<operation> "<resource>"`, the subject of every failure message. */
export function callLabel(operation: string, resourceName: string): string {
  return `${operation} "${resourceName}"`;
}

/** Put a request together. Whatever that raises that is not already a model
 *  failure is a request that could not be built. */
export function building<T>(label: string, ctx: InvokeContext | undefined, build: () => T): T {
  try {
    return build();
  } catch (err) {
    throw modelFailureFromError(err, ctx, (unbuilt) => requestUnbuilt(label, unbuilt));
  }
}

/** Read a success response. Whatever that raises that is not already a model
 *  failure is an answer that could not be read. */
export function reading<T>(label: string, ctx: InvokeContext | undefined, read: () => T): T {
  try {
    return read();
  } catch (err) {
    throw modelFailureFromError(err, ctx, (unread) => answerUnreadable(label, unread));
  }
}

/** The same for an answer read as it arrives: the parts pass through, and what
 *  ends the reading rejects the iteration as {@link reading} would raise it.
 *  A consumer that stops early stops the reading beneath. */
export async function* readingParts<T>(
  label: string,
  ctx: InvokeContext | undefined,
  parts: AsyncIterable<T>,
): AsyncGenerator<T> {
  try {
    yield* parts;
  } catch (err) {
    throw modelFailureFromError(err, ctx, (unread) => answerUnreadable(label, unread));
  }
}

/**
 * One buffered call, answered with the decoded JSON object.
 *
 * THIS IS THE ERROR BOUNDARY, for a buffered call: a rejection of the request,
 * a status that is not a success, a success body that is not a JSON object, and
 * a success body carrying the vendor's error object each leave as one of the
 * codes `Ai.Model` declares. The status is judged here rather than through the
 * injected request's `throwOnHttpError` — that is the author's setting, and a
 * code that changed with it could not be written into a `catches:`.
 */
export async function callMessages(
  request: HttpRequestInstance,
  label: string,
  call: MessagesCall,
  ctx?: InvokeContext,
): Promise<Record<string, unknown>> {
  const { response, success } = await sendMessages(request, label, call, "text", ctx);
  if (!success) throw refusal(label, ctx, response);
  return reading(label, ctx, () => decodeAnswer(label, response));
}

/** How much of a refused streamed body is read for its explanation. A message,
 *  not a payload, so a bound is not a compromise. */
const MAX_FAILURE_BODY = 2048;

/**
 * One streamed call, answered with the response's byte stream. The same
 * boundary as {@link callMessages} up to the status; what the events hold is
 * the caller's to read.
 *
 * A refused response's body is a stream too: it is read to text under a bound
 * and released, so the vendor's explanation reaches the error and no unread
 * handle is left behind.
 */
export async function openMessagesStream(
  request: HttpRequestInstance,
  label: string,
  call: MessagesCall,
  ctx?: InvokeContext,
): Promise<AsyncIterable<unknown>> {
  const { response, success } = await sendMessages(request, label, call, "stream", ctx);
  if (success) {
    return reading(label, ctx, () => {
      const body = response.body;
      if (!isAsyncIterable(body)) {
        throw modelResponseInvalid(`${label}: the endpoint answered with no body to read as a stream.`);
      }
      return body;
    });
  }
  if (!isAsyncIterable(response.body)) throw refusal(label, ctx, response);
  const drained = await drainToText(response.body);
  const explained = { ...response, body: drained.text };
  if (drained.failure === undefined) throw refusal(label, ctx, explained);
  // The status is the failure. A body that broke while its explanation was
  // being read shortens the message and is kept as the cause — unless the break
  // is the caller cancelling, which is then what happened.
  throw modelFailureFromError(drained.failure, ctx, (broke) =>
    failedResponse(label, explained, { cause: broke }),
  );
}

async function drainToText(
  body: AsyncIterable<unknown>,
): Promise<{ text: string; failure?: unknown }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let failure: unknown;
  try {
    // Leaving the loop early returns the body, which is what releases it.
    for await (const chunk of body) {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
      chunks.push(buf);
      size += buf.length;
      if (size >= MAX_FAILURE_BODY) break;
    }
  } catch (err) {
    failure = err ?? new Error("the response body could not be read");
  }
  const text = Buffer.concat(chunks).subarray(0, MAX_FAILURE_BODY).toString("utf8");
  return failure === undefined ? { text } : { text, failure };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value != null && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  );
}

/** One call, with the body in the form asked for and the status judged: a
 *  response whose status cannot be read is a request that was not served, and so
 *  is a refused one whose members cannot be — a refused response is handed on as
 *  what was read of it here. */
export async function sendMessages(
  request: HttpRequestInstance,
  label: string,
  call: MessagesCall,
  responseType: "text" | "stream",
  ctx?: InvokeContext,
): Promise<{ response: MessagesResponse; success: boolean }> {
  // The slot is bound at create() for a module-level resource; inside a `with:`
  // scope a ref slot is not an injection site and can arrive unresolved.
  if (!request || typeof request.invoke !== "function") {
    throw modelInvalidReference(
      `${label}: 'request' is not a live Http.Request instance — ` +
        `a reference slot on a scoped resource is not injected; declare the request at module level.`,
    );
  }
  try {
    const response = await request.invoke(
      {
        url: MESSAGES_PATH,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": ANTHROPIC_VERSION,
          ...(call.betas && call.betas.length > 0 ? { "anthropic-beta": call.betas.join(",") } : {}),
        },
        body: call.body,
        responseType,
      },
      ctx,
    );
    if (isSuccess(response)) return { response, success: true };
    const refused = { status: response.status, headers: response.headers, body: response.body };
    return { response: refused, success: false };
  } catch (err) {
    throw modelFailureFromError(err, ctx, (rejected) => requestRejection(label, rejected));
  }
}

/** The status as a plain number: the request declares it an integer, so it
 *  arrives as an int64. */
function statusOf(response: MessagesResponse): number | undefined {
  return integerInput(response.status);
}

export function isSuccess(response: MessagesResponse): boolean {
  const status = statusOf(response);
  return status !== undefined && status >= 200 && status < 300;
}

/** The failure of a response the endpoint did not serve, with the wait it asked
 *  for when it named one. */
export function failedResponse(
  label: string,
  response: MessagesResponse,
  options: { cause?: unknown } = {},
): InvokeError {
  return responseFailure(
    label,
    { status: response.status, retryAfter: response.headers?.["retry-after"] },
    response.body,
    options,
  );
}

/** The failure of a refused response, for a model kind's own call. No success
 *  response is in hand, so when judging the refusal itself fails, that is a
 *  request that was not served. */
function refusal(label: string, ctx: InvokeContext | undefined, response: MessagesResponse): unknown {
  try {
    return failedResponse(label, response);
  } catch (err) {
    return modelFailureFromError(err, ctx, (rejected) => requestRejection(label, rejected));
  }
}

/** The start of a body that could not be read, for the message. */
function excerpt(body: string): string {
  return JSON.stringify(body.length > 200 ? `${body.slice(0, 200)}…` : body);
}

/**
 * A success response's body as the JSON object the API answers with.
 *
 * A body that is empty, not JSON or not an object is an answer that cannot be
 * read. One carrying the vendor's error object is a failure the endpoint
 * reported under a success status: it wins over any answer beside it.
 */
export function decodeAnswer(label: string, response: MessagesResponse): Record<string, unknown> {
  const body = response.body;
  if (typeof body !== "string" || body.trim() === "") {
    throw modelResponseInvalid(`${label}: the endpoint answered ${statusOf(response)} with no body.`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch (err) {
    throw modelResponseInvalid(
      `${label}: the endpoint answered ${statusOf(response)} with a body that is not JSON. ` +
        `It begins: ${excerpt(body)}`,
      { cause: err },
    );
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw modelResponseInvalid(
      `${label}: the endpoint answered ${statusOf(response)} with a body that is not a JSON ` +
        `object. It begins: ${excerpt(body)}`,
    );
  }
  const error = vendorErrorOf(decoded);
  if (error) throw reportedFailure(label, "the endpoint reported a failure in its answer", error);
  return decoded as Record<string, unknown>;
}
