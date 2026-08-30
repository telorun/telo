import { InvokeError, type InvokeContext } from "@telorun/sdk";

/**
 * The endpoint seam: every call goes through an injected `Http.Request`.
 *
 * Not `fetch`. A provider that calls fetch has to apply the credential itself
 * and re-implement the 401 re-acquire-and-retry that `http-client` already
 * owns — a second implementation of the thing declaring the credential was
 * meant to consolidate. Driving the request instead means the account (base
 * URL, credential, timeout, retry) is declared once by the author, and this
 * module carries no key at all.
 */

/** What Phase-5 injection leaves in the `request` slot. */
export interface HttpRequestInstance {
  invoke(inputs: Record<string, unknown>, ctx?: InvokeContext): Promise<OpenAiResponse>;
}

export interface OpenAiResponse {
  status: number;
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
  /** A byte stream rather than a parsed body — the SSE path. */
  stream?: boolean;
}

/** How much of a failed response body is carried into the error. A message,
 *  not a payload, so a bound is not a compromise. */
const MAX_FAILURE_BODY = 2048;

/**
 * Issue one call and hand back its body.
 *
 * THIS IS THE ERROR BOUNDARY. The status is checked here rather than relying on
 * the injected request's `throwOnHttpError`: that is the author's setting, and a
 * provider whose error code changed with someone else's configuration would be
 * impossible to write a `catches:` against. When it IS set, `http-client` raises
 * `ERR_HTTP_STATUS` first — so that is caught and re-raised as this module's own
 * code, with the status and the provider's body it already carries. The throws
 * union is definition-declared, so nothing else would propagate the transport's
 * code into a consumer's coverage check.
 */
export async function callOpenAi(
  request: HttpRequestInstance,
  resourceName: string,
  operation: string,
  call: OpenAiCall,
  ctx?: InvokeContext,
): Promise<unknown> {
  const response = await sendOpenAi(request, resourceName, operation, call, ctx);
  if (!isSuccess(response)) throw openAiFailure(resourceName, operation, response);
  return response.body;
}

/** One call, status unjudged — for a caller that reads a refusal off a failed
 *  response before deciding it is an error. A failed STREAMED response is drained
 *  to text under a bound, so the provider's explanation reaches the error instead
 *  of an unread handle. */
export async function sendOpenAi(
  request: HttpRequestInstance,
  resourceName: string,
  operation: string,
  call: OpenAiCall,
  ctx?: InvokeContext,
): Promise<OpenAiResponse> {
  // The slot is bound at create() for a module-level resource; inside a `with:`
  // scope a ref slot is not an injection site and can arrive unresolved.
  if (!request || typeof request.invoke !== "function") {
    throw new InvokeError(
      "ERR_INVALID_REFERENCE",
      `${operation} "${resourceName}": 'request' is not a live Http.Request instance — ` +
        `a reference slot on a scoped resource is not injected; declare the request at module level.`,
    );
  }

  let response: OpenAiResponse;
  try {
    response = await request.invoke(
      {
        url: call.path,
        method: "POST",
        headers: { "content-type": call.contentType ?? "application/json" },
        body: call.body,
        ...(call.stream ? { responseType: "stream" } : {}),
      },
      ctx,
    );
  } catch (err) {
    if (err instanceof InvokeError && err.code === "ERR_HTTP_STATUS") {
      const data = (err.data ?? {}) as { status?: number; body?: unknown };
      throw openAiFailure(resourceName, operation, {
        status: data.status ?? 0,
        headers: {},
        body: data.body,
      });
    }
    throw err;
  }
  if (!isSuccess(response) && isAsyncIterable(response.body)) {
    return { ...response, body: await drainToText(response.body) };
  }
  return response;
}

async function drainToText(body: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of body) {
      const buf = Buffer.from(chunk as Uint8Array);
      chunks.push(buf);
      size += buf.length;
      if (size >= MAX_FAILURE_BODY) break;
    }
  } finally {
    (body as { destroy?: () => void }).destroy?.();
  }
  return Buffer.concat(chunks).subarray(0, MAX_FAILURE_BODY).toString("utf8");
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value != null && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  );
}

export function isSuccess(response: OpenAiResponse): boolean {
  return response.status >= 200 && response.status < 300;
}

export function openAiFailure(
  resourceName: string,
  operation: string,
  response: OpenAiResponse,
): InvokeError {
  return new InvokeError(
    "ERR_OPENAI_REQUEST_FAILED",
    `${operation} "${resourceName}": the endpoint answered ${response.status}. ` +
      `${describeFailure(response.body)}`,
    { status: response.status },
  );
}

/** The provider's own explanation, when the body carries one. A failed JSON
 *  response is already parsed by the time it reaches here; a streamed one is a
 *  handle nobody read, and saying so beats printing `[object Object]`. */
function describeFailure(body: unknown): string {
  if (typeof body === "string") {
    try {
      // A drained stream or a text response may still be the provider's JSON.
      const parsed = JSON.parse(body) as { error?: { message?: unknown } };
      if (typeof parsed?.error?.message === "string") return parsed.error.message;
    } catch {
      // Plain text — reported as it is.
    }
    return body.slice(0, MAX_FAILURE_BODY);
  }
  const error = (body as { error?: { message?: unknown } } | undefined)?.error;
  if (error && typeof error.message === "string") return error.message;
  if (body && typeof body === "object" && !isAsyncIterable(body)) {
    return JSON.stringify(body).slice(0, MAX_FAILURE_BODY);
  }
  return "The response body was not read.";
}
