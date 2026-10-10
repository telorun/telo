import { modelFailureFromError, modelInvalidReference, modelResponseInvalid } from "@telorun/ai";
import { integerInput, type InvokeContext, type InvokeError } from "@telorun/sdk";
import {
  answerUnreadable,
  reportedFailure,
  requestRejection,
  requestUnbuilt,
  responseFailure,
  vendorErrorOf,
} from "./openai-failure.js";

/**
 * The endpoint seam: every call goes through an injected `Http.Request`.
 *
 * Not `fetch`. A provider that calls fetch has to apply the credential itself
 * and re-implement the 401 re-acquire-and-retry that `http-client` already
 * owns — a second implementation of the thing declaring the credential was
 * meant to consolidate. Driving the request instead means the account (base
 * URL, credential, timeout, retry) is declared once by the author, and this
 * module carries no key at all.
 *
 * THE TRANSPORT CARRIES BYTES; THIS MODULE DECODES. A buffered call asks for the
 * body as text and a streamed one as a stream, never as parsed JSON: the wire
 * dialect is this module's, so reading it — and the code a body that cannot be
 * read is raised under — is too. An author's `success:` / `retryOn:` rule on a
 * request handed to a model kind therefore sees `body` as undecoded text.
 *
 * EVERY ERROR OF A CALL LEAVES THROUGH ONE BOUNDARY, `modelFailureFromError`,
 * which passes what is not a model failure and asks this module about the rest.
 * The answer depends on how far the call got: until a success response is in
 * hand it is a request that was not served, and from then on an answer that
 * could not be read. {@link building}, {@link reading} and
 * {@link readingParts} are that boundary for the code a model kind runs itself.
 */

/** What Phase-5 injection leaves in the `request` slot. */
export interface HttpRequestInstance {
  invoke(inputs: Record<string, unknown>, ctx?: InvokeContext): Promise<OpenAiResponse>;
}

export interface OpenAiResponse {
  /** A number, or the int64 a declared-integer output crosses a dispatch as. */
  status: number | bigint;
  headers: Record<string, string>;
  body: unknown;
}

export interface OpenAiCall {
  path: string;
  /** A JSON document, or already-framed bytes sent under `contentType`. */
  body: unknown;
  /** The media type of a byte body — a multipart form carries its boundary here.
   *  A JSON body needs none. */
  contentType?: string;
  /** A byte stream rather than a text body — the SSE path. */
  stream?: boolean;
}

/** How much of a failed streamed body is read for its explanation. A message,
 *  not a payload, so a bound is not a compromise. */
const MAX_FAILURE_BODY = 2048;

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
export async function callOpenAi(
  request: HttpRequestInstance,
  resourceName: string,
  operation: string,
  call: OpenAiCall,
  ctx?: InvokeContext,
): Promise<Record<string, unknown>> {
  const label = callLabel(operation, resourceName);
  const response = await sendOpenAi(request, resourceName, operation, call, ctx);
  if (!isSuccess(response)) throw refusal(label, ctx, response);
  return reading(label, ctx, () => decodeAnswer(label, response));
}

/**
 * One streamed call, answered with the response's byte stream. The same
 * boundary as {@link callOpenAi} up to the status; what the frames hold is the
 * caller's to read.
 */
export async function openOpenAiStream(
  request: HttpRequestInstance,
  resourceName: string,
  operation: string,
  call: OpenAiCall,
  ctx?: InvokeContext,
): Promise<AsyncIterable<Uint8Array>> {
  const label = callLabel(operation, resourceName);
  const response = await sendOpenAi(request, resourceName, operation, { ...call, stream: true }, ctx);
  if (!isSuccess(response)) throw refusal(label, ctx, response);
  return reading(label, ctx, () => {
    const body = response.body;
    if (!isAsyncIterable(body)) {
      throw modelResponseInvalid(`${label}: the endpoint answered with no body to read as a stream.`);
    }
    return body as AsyncIterable<Uint8Array>;
  });
}

/** One call, status unjudged — for a caller that reads a refusal off a failed
 *  response before deciding it is an error. A failed STREAMED response is drained
 *  to text under a bound and released, so the vendor's explanation reaches the
 *  error instead of an unread handle; when the body breaks while it is drained,
 *  the status failure is raised here with the break as its cause. */
export async function sendOpenAi(
  request: HttpRequestInstance,
  resourceName: string,
  operation: string,
  call: OpenAiCall,
  ctx?: InvokeContext,
): Promise<OpenAiResponse> {
  const label = callLabel(operation, resourceName);
  // The slot is bound at create() for a module-level resource; inside a `with:`
  // scope a ref slot is not an injection site and can arrive unresolved.
  if (!request || typeof request.invoke !== "function") {
    throw modelInvalidReference(
      `${label}: 'request' is not a live Http.Request instance — ` +
        `a reference slot on a scoped resource is not injected; declare the request at module level.`,
    );
  }

  let response: OpenAiResponse;
  let refusedStream: AsyncIterable<unknown> | undefined;
  try {
    response = await request.invoke(
      {
        url: call.path,
        method: "POST",
        headers: { "content-type": call.contentType ?? "application/json" },
        body: call.body,
        responseType: call.stream ? "stream" : "text",
      },
      ctx,
    );
    refusedStream =
      !isSuccess(response) && isAsyncIterable(response.body) ? response.body : undefined;
  } catch (err) {
    throw modelFailureFromError(err, ctx, (rejected) => requestRejection(label, rejected));
  }
  if (refusedStream === undefined) return response;
  const drained = await drainToText(refusedStream);
  const explained = { ...response, body: drained.text };
  if (drained.failure === undefined) return explained;
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
    for await (const chunk of body) {
      const buf = Buffer.from(chunk as Uint8Array);
      chunks.push(buf);
      size += buf.length;
      if (size >= MAX_FAILURE_BODY) break;
    }
  } catch (err) {
    failure = err ?? new Error("the response body could not be read");
  } finally {
    (body as { destroy?: () => void }).destroy?.();
  }
  const text = Buffer.concat(chunks).subarray(0, MAX_FAILURE_BODY).toString("utf8");
  return failure === undefined ? { text } : { text, failure };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value != null && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  );
}

/** The status as a plain number: the request declares it an integer, so it
 *  arrives as an int64. */
function statusOf(response: OpenAiResponse): number | undefined {
  return integerInput(response.status);
}

export function isSuccess(response: OpenAiResponse): boolean {
  const status = statusOf(response);
  return status !== undefined && status >= 200 && status < 300;
}

/** The failure of a response the endpoint did not serve, with the wait it asked
 *  for when it named one. */
export function failedResponse(
  label: string,
  response: OpenAiResponse,
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
function refusal(label: string, ctx: InvokeContext | undefined, response: OpenAiResponse): unknown {
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
 * A success response's body as the JSON object every dialect answers with.
 *
 * A body that is empty, not JSON or not an object is an answer that cannot be
 * read. One carrying the vendor's error object is a failure the endpoint
 * reported under a success status: it wins over any answer beside it.
 */
export function decodeAnswer(label: string, response: OpenAiResponse): Record<string, unknown> {
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
