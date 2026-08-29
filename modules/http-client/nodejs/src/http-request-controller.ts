import {
  ERR_INVOKE_CANCELLED,
  InvokeError,
  SEVERITY,
  Stream,
  networkCauseCode,
  parseDurationMs,
  type InvokeContext,
  type Logger,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import type { CredentialApplier } from "./http-client-controller.js";
import { PassThrough, Readable } from "stream";

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT = 10000;

/** What every HTTP client treats as worth another try, and what Google's API
 *  guidance mandates backoff on. A list rather than a predicate because this is
 *  the default: an author who needs more says so. */
const DEFAULT_RETRY_STATUSES = [408, 429, 500, 502, 503, 504];

const DEFAULT_RETRY: ResolvedRetry = {
  attempts: 0,
  initialDelay: 250,
  factor: 2,
  maxDelay: 32_000,
  jitter: "full",
  honorRetryAfter: true,
};

/** The policy after resolution: `delay` is folded into `initialDelay`, so the
 *  deprecated spelling exists on the authored shape and nowhere past it. */
type ResolvedRetry = Required<Omit<RetryPolicy, "delay">>;

interface RetryPolicy {
  attempts?: number;
  initialDelay?: number;
  factor?: number;
  maxDelay?: number;
  jitter?: "none" | "full";
  honorRetryAfter?: boolean;
  /** DEPRECATED duration string (`"250ms"`, `"1s"`) — read as `initialDelay`
   *  when that is absent, exactly as the step leaf reads it. The shared retry
   *  fragment carries the field, so accepting it here without honouring it would
   *  make one declared shape mean two different things depending on where it was
   *  written — and would swallow a backoff the author asked for. */
  delay?: string;
}

/** A body that cannot be produced twice. Raised rather than silently re-sending
 *  nothing: a consumed stream re-read yields zero bytes, so the second attempt
 *  would succeed against an empty payload and look like a successful upload. */
const ERR_BODY_NOT_REPLAYABLE = "ERR_HTTP_BODY_NOT_REPLAYABLE";

/** A status the request did not declare successful, under `throwOnHttpError`. */
const ERR_HTTP_STATUS = "ERR_HTTP_STATUS";

/** How much of a failed response body is carried into the error.
 *
 *  An error body is a MESSAGE, so a bound is not a compromise: a failing
 *  endpoint that answers with megabytes must not turn the error path into an
 *  out-of-memory, and no explanation needs more than this. */
const MAX_FAILURE_BODY = 8192;

type ResponseType = "json" | "text" | "bytes" | "stream";

/** The bytes to send, already resolved from whatever the manifest declared.
 *  A stream is kept as a handle, so nothing buffers it on the way in. */
type OutgoingBody = string | Uint8Array | Readable | undefined;

interface TeloResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

interface NetworkErrorPayload {
  error: "NetworkError";
  code: "TIMEOUT" | "CONNECTION_REFUSED" | "DNS_RESOLUTION_FAILED" | "SSL_ERROR";
  message: string;
  details: { url: string };
}

function createNetworkError(
  code: NetworkErrorPayload["code"],
  message: string,
  url: string,
): Error {
  const payload: NetworkErrorPayload = {
    error: "NetworkError",
    code,
    message,
    details: { url },
  };
  const err = new Error(message);
  (err as any).networkError = payload;
  (err as any).code = code;
  Object.assign(err, payload);
  return err;
}

// Classify on the cause chain's `code`, never on the message: `fetch` rejects
// with the literal text "fetch failed" for DNS, refusal, and TLS alike, so
// substring tests against the message never match and everything collapses into
// the fallback branch. The code is also what the message reports, so a DNS
// failure now says ENOTFOUND rather than "fetch failed".
function mapNetworkError(err: unknown, url: string): never {
  const e = err as Error;
  if (e.name === "AbortError") {
    throw createNetworkError("TIMEOUT", `Request timed out`, url);
  }
  const code = networkCauseCode(err);
  const detail = code ? `${code} (${e.message})` : e.message;
  switch (code) {
    case "ECONNREFUSED":
      throw createNetworkError("CONNECTION_REFUSED", detail, url);
    case "ENOTFOUND":
    case "EAI_AGAIN":
      throw createNetworkError("DNS_RESOLUTION_FAILED", detail, url);
    case "ETIMEDOUT":
    case "UND_ERR_CONNECT_TIMEOUT":
      throw createNetworkError("TIMEOUT", detail, url);
    case "CERT_HAS_EXPIRED":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "EPROTO":
      throw createNetworkError("SSL_ERROR", detail, url);
    default:
      throw createNetworkError("CONNECTION_REFUSED", detail, url);
  }
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key.toLowerCase()] = value;
  }
  return result;
}

async function executeRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: OutgoingBody,
  timeout: number,
  responseType: ResponseType,
  isSuccess: (status: number, headers: Record<string, string>) => boolean,
  callerSignal?: AbortSignal,
): Promise<TeloResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  // Caller cancellation and the request timeout both abort the fetch.
  const signal = callerSignal
    ? AbortSignal.any([controller.signal, callerSignal])
    : controller.signal;

  let currentUrl = url;
  let redirectsLeft = MAX_REDIRECTS;

  try {
    while (true) {
      const response = await fetch(currentUrl, {
        method,
        headers,
        body: body as BodyInit | undefined,
        // A Node stream body is half-duplex: without this, undici refuses to
        // send a request whose body is a stream.
        ...(body instanceof Readable ? { duplex: "half" } : {}),
        redirect: "manual",
        signal,
      } as RequestInit);

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key.toLowerCase()] = value;
      });

      // CLASSIFICATION PRECEDES REDIRECT-FOLLOWING. A status the request
      // declares successful is an answer, not a detour — which is the whole of
      // what a resumable upload needs to read a 308 rather than chase it. Only
      // the status and headers are consulted here: the body is not read yet, and
      // reading it to decide whether to follow would buffer a response the caller
      // may have asked to stream.
      if (
        (response.status === 301 || response.status === 302) &&
        redirectsLeft > 0 &&
        !isSuccess(response.status, responseHeaders)
      ) {
        const location = response.headers.get("location");
        if (location) {
          currentUrl = location.startsWith("http")
            ? location
            : new URL(location, currentUrl).toString();
          redirectsLeft--;
          // For redirects, switch to GET and drop body per HTTP spec
          method = "GET";
          body = undefined;
          delete headers["content-length"];
          continue;
        }
      }

      return {
        status: response.status,
        headers: responseHeaders,
        body: await readBody(response, responseType, responseHeaders, () => controller.abort()),
      };
    }
  } catch (err) {
    // Caller cancellation (not the timeout) surfaces as the structured invoke
    // cancellation rather than masquerading as a network TIMEOUT.
    if (callerSignal?.aborted) {
      throw new InvokeError(ERR_INVOKE_CANCELLED, "Request cancelled");
    }
    mapNetworkError(err, url);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Read the response body the way the call asked for.
 *
 * `bytes` exists because the buffered path used to be "parse when the content
 * type says JSON, otherwise a raw string", and reading binary as a string
 * corrupts it — a PNG that survives the wire does not survive `response.text()`.
 * `text` is the honest name for that old fallback, so a caller that wants a
 * string says so rather than getting one by omission.
 */
export async function readBody(
  response: Response,
  responseType: ResponseType,
  responseHeaders: Record<string, string>,
  abortRequest: () => void,
): Promise<unknown> {
  if (responseType === "stream") {
    // Pumped eagerly into a PassThrough so data flows as it arrives rather than
    // when the consumer first pulls.
    const webStream = response.body;
    const out = new PassThrough();
    if (!webStream) {
      out.end();
      return out;
    }
    const reader = webStream.getReader();
    // Whether the pump reached its own end — normally or by failing. It is the
    // only thing that distinguishes a stream nobody wants any more from one
    // that is simply finished, and both close the PassThrough.
    let settled = false;

    // ABANDONMENT. A consumer that stops draining destroys this PassThrough:
    // `for await` calls `return()` on `break`, and Node destroys the readable.
    // That close is the ONLY signal the transport gets, and without acting on
    // it the pump keeps reading a response nobody will ever read — socket open,
    // tokens billing, which is the editor's commonest path when a user stops a
    // turn. Cancelling the reader and aborting the request is what carries the
    // consumer's early exit back to the producer.
    out.on("close", () => {
      if (settled) return;
      settled = true;
      void reader.cancel().catch(() => {
        // The reader is already errored or released; the abort below is what
        // actually ends the request, so there is nothing this could add.
      });
      abortRequest();
    });

    void (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          out.push(Buffer.from(value));
        }
        settled = true;
        reader.releaseLock();
        out.end();
      } catch (err) {
        // An abandonment cancel surfaces here as a rejected read. The consumer
        // is already gone and the stream already destroyed, so re-destroying it
        // would replace their reason with ours.
        if (settled) return;
        settled = true;
        out.destroy(err as Error);
      }
    })();
    return out;
  }

  if (responseType === "bytes") {
    return new Uint8Array(await response.arrayBuffer());
  }

  if (responseType === "text") return response.text();

  const contentType = responseHeaders["content-type"] ?? "";
  if (contentType.includes("application/json")) {
    const text = await response.text();
    return text.length === 0 ? null : JSON.parse(text);
  }
  return response.text();
}

/**
 * The provider's explanation of a failure, as text, whatever response type the
 * call asked for.
 *
 * A streamed body is DRAINED here rather than skipped: it is the one shape
 * where the bytes have arrived and nobody has read them, so leaving it alone is
 * what made a streamed failure report a status line with no cause. Bounded, and
 * destroyed afterwards — the caller never receives this stream, so if this does
 * not end it nothing will.
 */
async function failureDetail(
  body: unknown,
  responseType: ResponseType,
): Promise<string | undefined> {
  if (body === null || body === undefined) return undefined;

  if (responseType === "stream") {
    const stream = body as PassThrough;
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of stream) {
        const buf = Buffer.from(chunk as Buffer);
        chunks.push(buf);
        size += buf.length;
        if (size >= MAX_FAILURE_BODY) break;
      }
    } finally {
      stream.destroy();
    }
    const text = Buffer.concat(chunks).subarray(0, MAX_FAILURE_BODY).toString("utf8");
    return text.length > 0 ? text : undefined;
  }

  if (typeof body === "string") {
    return body.length > 0 ? body.slice(0, MAX_FAILURE_BODY) : undefined;
  }
  if (body instanceof Uint8Array) {
    const text = Buffer.from(body).subarray(0, MAX_FAILURE_BODY).toString("utf8");
    return text.length > 0 ? text : undefined;
  }
  // A parsed body came from JSON.parse, so it is acyclic and re-encodable.
  return JSON.stringify(body)?.slice(0, MAX_FAILURE_BODY);
}

/**
 * The safe half of a URL, as attributes that mean exactly what they say.
 *
 * NOT `url.full`: that convention means the absolute URL, and publishing a
 * query-stripped value under it hands an OTLP consumer a URL that silently
 * differs from the request actually made. `server.address` / `server.port` /
 * `url.path` / `url.scheme` are accurate as written.
 *
 * The query string and any userinfo are dropped rather than scrubbed, so no
 * credential can reach a record by construction — §14.4 requires a logged URL to
 * be scrubbed where credentials are identifiable (`X-Amz-Signature`, `sig`, …),
 * and not carrying the query is the only form of that which cannot be defeated
 * by a parameter nobody thought to list.
 */
function urlAttributes(url: string): Record<string, string | number> | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Unparseable — omit the keys entirely rather than emit empty strings, which
    // an OTLP consumer cannot tell from "the host really was empty".
    return undefined;
  }
  const attributes: Record<string, string | number> = {
    "url.scheme": parsed.protocol.replace(/:$/, ""),
    "server.address": parsed.hostname,
    "url.path": parsed.pathname,
  };
  if (parsed.port) attributes["server.port"] = Number(parsed.port);
  return attributes;
}

interface RequestAttempt {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: OutgoingBody;
  timeout: number;
  retry: ResolvedRetry;
  log: Logger;
  responseType: ResponseType;
  isSuccess: (status: number, headers: Record<string, string>, body: unknown) => boolean;
  isRetryable: (status: number, headers: Record<string, string>, body: unknown) => boolean;
  callerSignal?: AbortSignal;
}

/** The wait before re-attempt number `resend` (1-based), and never below what the
 *  server asked for. Full jitter picks uniformly from [0, delay]: a fleet that
 *  failed together must not re-attempt together, and spreading the whole interval
 *  is what actually decorrelates them. */
function retryDelay(
  policy: ResolvedRetry,
  resend: number,
  headers: Record<string, string>,
): RetryWait {
  const backoff = Math.min(
    policy.maxDelay,
    policy.initialDelay * Math.pow(policy.factor, Math.max(0, resend - 1)),
  );
  const jittered = policy.jitter === "full" ? Math.random() * backoff : backoff;
  if (!policy.honorRetryAfter) return { delay: jittered };
  const after = parseRetryAfter(headers["retry-after"]);
  if (after === undefined) return { delay: jittered };
  // A server asking for LONGER than the policy's own ceiling is not a delay to
  // honour — `Retry-After: 86400` would park the invocation for a day, and the
  // per-attempt timeout does not bound a wait. Past the ceiling the honest answer
  // is to stop retrying rather than to sleep past a bound the author set.
  if (after > policy.maxDelay) return { delay: after, exceedsCeiling: true };
  // Within the ceiling the server's number is better information than any local
  // curve, so it raises the delay — it never lowers one the policy chose.
  return { delay: Math.max(jittered, after) };
}

interface RetryWait {
  delay: number;
  /** The server asked for longer than `maxDelay`; the caller stops instead. */
  exceedsCeiling?: boolean;
}

/** `Retry-After` is either delta-seconds or an HTTP date. Milliseconds out; an
 *  unparseable or past value yields undefined rather than 0, which would read as
 *  "the server asked for no delay". */
function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  const delta = at - Date.now();
  return delta > 0 ? delta : undefined;
}

/**
 * Wait, but stay cancellable.
 *
 * A bare `setTimeout` parks a cancelled invocation for the whole delay — up to
 * `maxDelay` per attempt — because the caller's signal is threaded into `fetch`
 * and nowhere else, and the per-attempt timeout does not bound a sleep. Rejects
 * with the same structured cancellation the request path raises, so a cancelled
 * retry and a cancelled request are one error to a caller.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new InvokeError(ERR_INVOKE_CANCELLED, "Request cancelled"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new InvokeError(ERR_INVOKE_CANCELLED, "Request cancelled"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * One request, re-attempted while the policy allows and the outcome is
 * retryable.
 *
 * Two kinds of outcome are retryable and they arrive differently: a network
 * failure throws, a rejected response returns. Both run through the same
 * attempt counter and the same backoff, because an author who says "five
 * attempts" means five, not five-per-failure-mode.
 *
 * A NON-REPLAYABLE BODY IS REFUSED RATHER THAN RE-SENT. A stream has been
 * consumed by the first attempt, so a second would transmit nothing and a server
 * would answer 200 to an empty payload — a silent, successful-looking corruption.
 * Iterative rather than recursive so the attempt counter is the loop variable.
 */
async function executeWithRetry(attempt: RequestAttempt): Promise<TeloResponse> {
  const {
    url,
    method,
    headers,
    body,
    timeout,
    retry,
    log,
    responseType,
    isSuccess,
    isRetryable,
    callerSignal,
  } = attempt;
  const successForRedirect = (status: number, h: Record<string, string>): boolean =>
    isSuccess(status, h, undefined);

  // Checked ONCE, before anything is sent. A stream body with a non-zero attempt
  // budget is a manifest fault knowable without a request, and raising it here
  // means the author is told what is wrong instead of learning it only when a
  // retry is reached — where the error would also have to displace the network
  // failure that prompted the retry, hiding whether it was a timeout or a refusal.
  if (retry.attempts > 0) assertReplayable(body, url);

  for (let resendCount = 0; ; resendCount++) {
    const canResend = resendCount < retry.attempts;
    try {
      const response = await executeRequest(
        url,
        method,
        headers,
        body,
        timeout,
        responseType,
        successForRedirect,
        callerSignal,
      );
      if (isSuccess(response.status, response.headers, response.body)) return response;
      if (!canResend || !isRetryable(response.status, response.headers, response.body)) {
        return response;
      }
      const wait = retryDelay(retry, resendCount + 1, response.headers);
      if (wait.exceedsCeiling) {
        log.warn("Retry-After exceeds the retry ceiling; returning the response", {
          "http.request.method": method,
          ...urlAttributes(url),
          "http.response.status_code": response.status,
          "http.request.resend_delay": wait.delay / 1000,
        });
        return response;
      }
      log.warn("Request returned a retryable status; retrying", {
        "http.request.method": method,
        ...urlAttributes(url),
        "http.response.status_code": response.status,
        "http.request.resend_count": resendCount + 1,
        "http.request.resend_delay": wait.delay / 1000,
      });
      // A rejected response's body was buffered before this point, so nothing
      // is left open. A STREAM response is different: the caller asked not to
      // buffer, so `retryOn` on a streamed call is the author's statement that
      // the status alone decides, and the abandoned PassThrough is destroyed.
      if (responseType === "stream") (response.body as PassThrough | undefined)?.destroy();
      await sleep(wait.delay, callerSignal);
      continue;
    } catch (err) {
      if (!canResend || (err as any).error !== "NetworkError") throw err;
      // Only the FINAL failure reaches the caller, so an attempt that failed and
      // was retried is invisible to everything except this record — including the
      // common case where the retry succeeds and the call looks perfectly healthy.
      const wait = retryDelay(retry, resendCount + 1, {});
      log.warn("Request failed; retrying", {
        "http.request.method": method,
        ...urlAttributes(url),
        "http.request.resend_count": resendCount + 1,
        "http.request.resend_delay": wait.delay / 1000,
        "error.type": String((err as any).code ?? "NetworkError"),
      });
      await sleep(wait.delay, callerSignal);
    }
  }
}

/** Refuse to re-send what cannot be produced again. Named error rather than a
 *  bare throw so a manifest can catch it by name, and raised at the moment the
 *  re-send is decided rather than when the empty request comes back 200. */
function assertReplayable(body: OutgoingBody, url: string): void {
  if (body instanceof Readable) {
    throw new InvokeError(
      ERR_BODY_NOT_REPLAYABLE,
      `Http.Request: the body of ${url} is a stream, which has already been consumed and ` +
        `cannot be re-sent. Retrying it would transmit an empty payload. Buffer the body ` +
        `(send bytes or a string), or chunk the upload so each request carries a replayable ` +
        `piece.`,
      { url },
    );
  }
}

interface HttpRequestInputs {
  url: string;
  method?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
  bodyEncoding?: "utf8" | "base64";
  responseType?: ResponseType;
}

interface HttpRequestManifest extends HttpRequestInputs {
  metadata?: { name?: string };
  // `client` is an x-telo-ref slot, so its runtime shape depends on where the
  // Http.Request sits. See resolveClientConfig for the forms it can take.
  client?: unknown;
  timeout?: number;
  throwOnHttpError?: boolean;
  success?: unknown;
  retryOn?: unknown;
  retry?: RetryPolicy;
  retries?: number;
  mode?: "buffer" | "stream";
  inputs?: HttpRequestInputs;
}

/**
 * Turn the declared body into the bytes to send, and say what content type it
 * implies.
 *
 * Bytes and a byte stream pass through untouched — that is the whole point of
 * admitting them, and `String(uint8array)` is what used to happen instead,
 * producing `137,80,78,...` on the wire with nothing to notice it. A string is
 * text unless `bodyEncoding` says it is base64, which is the escape hatch for a
 * payload that reached the manifest as text.
 */
function serializeBody(
  body: unknown,
  encoding: "utf8" | "base64" | undefined,
  declaredContentType: string | undefined,
): { body: OutgoingBody; contentType?: string } {
  if (body === undefined || body === null) return { body: undefined };
  if (body instanceof Uint8Array) {
    return { body, contentType: declaredContentType ?? "application/octet-stream" };
  }
  if (isNodeReadable(body)) {
    return { body, contentType: declaredContentType ?? "application/octet-stream" };
  }
  // A live Stream handle from another resource — an encoder, a chunker, an S3
  // get. Adapted rather than buffered: buffering here would defeat the reason
  // the producer streamed it.
  if (isAsyncIterable(body)) {
    return {
      body: Readable.from(body as AsyncIterable<Uint8Array>),
      contentType: declaredContentType ?? "application/octet-stream",
    };
  }
  if (typeof body === "object") {
    const contentType = declaredContentType ?? "application/json";
    return {
      body: contentType.includes("application/x-www-form-urlencoded")
        ? new URLSearchParams(body as Record<string, string>).toString()
        : JSON.stringify(body),
      contentType,
    };
  }
  const text = String(body);
  if (encoding === "base64") {
    return {
      body: Buffer.from(text, "base64"),
      contentType: declaredContentType ?? "application/octet-stream",
    };
  }
  // A plain string implies nothing: it always could have been any media type,
  // and guessing one here would start setting a header on requests that have
  // never carried it.
  return { body: text };
}

function isNodeReadable(value: unknown): value is Readable {
  return (
    !!value &&
    typeof (value as Readable).pipe === "function" &&
    typeof (value as Readable).read === "function"
  );
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value != null &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  );
}

/**
 * A response classifier from either spelling of the same field.
 *
 * EXPANDED FIRST, then branched on. The field is `x-telo-eval: runtime`, so what
 * the manifest hands over is a compiled expression whenever the author wrote
 * CEL — and the expression is free to produce either spelling, since the
 * declared schema admits both. Branching on the raw declaration instead read a
 * CEL-produced list as a predicate (never `true`, so every response was
 * classified a failure, silently) and a CEL leaf inside a literal list as `NaN`
 * (matching no status). Expansion is per response because the scope is the
 * response.
 *
 * Absent falls back to `fallback`, which is what keeps every existing request
 * behaving exactly as it did.
 */
function classifier(
  field: string,
  declared: unknown,
  expand: (expr: unknown, scope: Record<string, unknown>) => unknown,
  fallback: (status: number) => boolean,
): (status: number, headers: Record<string, string>, body: unknown) => boolean {
  if (declared === undefined || declared === null) return (status) => fallback(status);
  return (status, headers, body) => {
    const value = expand(declared, { status, headers, body: body ?? null });
    if (typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.some((code) => Number(code) === status);
    // Neither spelling. Raised rather than read as `false`, which would classify
    // every response the same way and give no clue why.
    throw new InvokeError(
      "ERR_HTTP_CLASSIFIER_INVALID",
      `Http.Request: '${field}' must resolve to a list of status codes or a boolean, ` +
        `but produced ${value === null ? "null" : typeof value}.`,
      { field, value },
    );
  };
}

interface ClientSnapshotInstance {
  snapshot: () => Record<string, unknown>;
  /** Present on a live Http.Client; absent on the raw-manifest fallback. */
  credential?: () => CredentialApplier | undefined;
}

function hasSnapshot(value: unknown): value is ClientSnapshotInstance {
  return !!value && typeof (value as { snapshot?: unknown }).snapshot === "function";
}

/** The client's config plus the credential it applies, already resolved by the
 *  client itself — the request never sees the slot's raw shape. */
interface ResolvedClient {
  config: Record<string, unknown>;
  credential: CredentialApplier | undefined;
}

/**
 * Normalize the `client` x-telo-ref value to a `{ name, alias? }` lookup.
 *
 * The value's shape depends on where the Http.Request sits:
 *   - Inline inside a scope (e.g. a Run.Sequence step's `invoke:`) hits the kernel's
 *     hidden-slot limitation (see resource-context.ts), so the reference arrives
 *     unresolved — a `!ref` sentinel or a `{kind, name, alias?}` object.
 *   - A bare resource-name string is still accepted by the analyzer as a legacy name
 *     reference, so it stays supported here.
 *
 * `{kind, name, alias?}` objects are read directly rather than routed through
 * `ctx.ensureKindRef`: an `alias` key there registers a spurious inline manifest and
 * drops the alias. Sentinels still go through `ensureKindRef`, which performs the
 * Self./Alias. split and cross-module export resolution.
 */
function normalizeClientRef(
  client: unknown,
  ctx: ResourceContext,
): { name: string; alias?: string } {
  if (typeof client === "string") return { name: client };
  if (client && typeof client === "object") {
    const ref = client as Record<string, unknown>;
    if (typeof ref.name === "string") {
      return { name: ref.name, alias: typeof ref.alias === "string" ? ref.alias : undefined };
    }
    const resolved = ctx.ensureKindRef(client) as { name: string; alias?: string };
    return { name: resolved.name, alias: resolved.alias };
  }
  throw new Error(
    "Http.Request: 'client' must reference an Http.Client (use 'client: !ref MyClient').",
  );
}

function clientOf(instance: ClientSnapshotInstance): ResolvedClient {
  return { config: instance.snapshot(), credential: instance.credential?.() };
}

/**
 * Resolve the `client` x-telo-ref slot to its config (baseUrl / headers / timeout)
 * and its `credential` slot. The returned config may still carry `${{ }}`
 * expressions; the caller expands them.
 */
function resolveClient(client: unknown, ctx: ResourceContext): ResolvedClient {
  // Top-level Http.Request: the kernel injects the live Http.Client instance at Phase 5.
  if (hasSnapshot(client)) return clientOf(client);

  const { name, alias } = normalizeClientRef(client, ctx);

  // Cross-module reference into an imported library's exported Http.Client instance.
  if (alias && alias !== "Self") {
    const instance = ctx.moduleContext.resolveImportedInstance(alias, name);
    if (!hasSnapshot(instance)) {
      throw new Error(
        `Http.Request: client reference '${alias}.${name}' did not resolve to an imported Http.Client instance.`,
      );
    }
    return clientOf(instance);
  }

  // Local reference. Prefer the live instance: a kind that inherits Http.Client
  // by `extends` (general single inheritance) is a delegated Client whose
  // snapshot() carries the resolved baseUrl/headers — its raw manifest holds the
  // child's own config (e.g. `host`), not a Client config. Only fall back to the
  // raw manifest for a genuine Http.Client at a scope site where no live instance
  // is registered.
  const live = ctx.moduleContext.resourceInstances.get(name)?.instance;
  if (hasSnapshot(live)) return clientOf(live);
  const resource = ctx.getResourcesByName("Client", name);
  if (!resource) {
    throw new Error(`Http.Request: Http.Client "${name}" not found.`);
  }
  // Raw-manifest fallback: no live client exists at this scope site, so there is
  // no owning context to resolve the credential in. Config still applies; a
  // credential declared on such a client is not reachable from here, and silently
  // resolving it against the REQUEST's imports would bind the wrong resource.
  const manifest = resource as unknown as Record<string, unknown>;
  if (manifest.credential !== undefined) {
    throw new Error(
      `Http.Request: Http.Client "${name}" declares a 'credential' but is not initialized at this ` +
        `site, so the credential cannot be resolved in the client's own context. ` +
        `Declare the client at module level rather than inside a scope.`,
    );
  }
  return { config: manifest, credential: undefined };
}

class HttpRequestResource implements ResourceInstance {
  constructor(
    private readonly manifest: HttpRequestManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(input: any, invokeCtx?: InvokeContext): Promise<TeloResponse> {
    const ctx = this.ctx;
    const m = this.manifest;

    // Resolve client config
    let clientBaseUrl = "";
    let clientHeaders: Record<string, string> = {};
    let clientTimeout = DEFAULT_TIMEOUT;

    let applyCredential: CredentialApplier | undefined;
    // Defaults the client supplies for policy an individual request may restate.
    // Backoff especially: it is a property of the API being called, not of one
    // call, so declaring it once per client is the common case.
    const clientDefaults: { throwOnHttpError?: boolean; retry?: RetryPolicy } = {};

    if (m.client) {
      const { config: clientConfig, credential } = resolveClient(m.client, ctx);
      applyCredential = credential;
      if (typeof clientConfig.throwOnHttpError === "boolean") {
        clientDefaults.throwOnHttpError = clientConfig.throwOnHttpError;
      }
      if (clientConfig.retry && typeof clientConfig.retry === "object") {
        clientDefaults.retry = clientConfig.retry as RetryPolicy;
      }

      const resolvedBaseUrl = ctx.expandValue(clientConfig.baseUrl ?? "", input ?? {});
      clientBaseUrl = typeof resolvedBaseUrl === "string" ? resolvedBaseUrl : "";

      const resolvedHeaders = ctx.expandValue(clientConfig.headers ?? {}, input ?? {});
      clientHeaders = normalizeHeaders((resolvedHeaders ?? {}) as Record<string, string>);

      const resolvedTimeout = ctx.expandValue(clientConfig.timeout ?? DEFAULT_TIMEOUT, input ?? {});
      clientTimeout =
        typeof resolvedTimeout === "number" && Number.isFinite(resolvedTimeout)
          ? resolvedTimeout
          : DEFAULT_TIMEOUT;
    }

    // Build the effective inputs by layering, lowest precedence to highest:
    //   1. manifest-level fields (url, method, ...) — fallback defaults
    //   2. m.inputs — manifest-baked inputs (legacy, still supported when present)
    //   3. call-site `input` — the canonical sibling-form invocation args
    // CEL expressions inside any of these resolve against `input` as the context.
    const callerInput = (input ?? {}) as Record<string, unknown>;
    const manifestInputs: HttpRequestInputs = {
      url: m.url,
      method: m.method,
      query: m.query,
      headers: m.headers,
      body: m.body,
      ...m.inputs,
      ...callerInput,
    };
    const resolved = ctx.expandValue(manifestInputs, callerInput) as HttpRequestInputs;
    const rawUrl = resolved.url as string;
    const method = ((resolved.method ?? "GET") || "GET").toUpperCase();
    const requestHeaders = normalizeHeaders((resolved.headers ?? {}) as Record<string, string>);
    const query = (resolved.query ?? {}) as Record<string, string>;
    const body = resolved.body;
    const effectiveTimeout = m.timeout ?? clientTimeout;
    const throwOnHttpError = m.throwOnHttpError ?? clientDefaults.throwOnHttpError ?? false;

    // `mode` is config and `responseType` is an input, so the deprecated field can
    // only ever be the fallback — a call that states one wins over an instance
    // that stated the other years ago.
    const responseType: ResponseType =
      resolved.responseType ?? (m.mode === "stream" ? "stream" : "json");

    // `retries` is the deprecated spelling of exactly one field of `retry`, so it
    // fills that field rather than competing with the policy.
    const declaredRetry = m.retry ?? clientDefaults.retry;
    const retry: ResolvedRetry = {
      ...DEFAULT_RETRY,
      ...(m.retries !== undefined ? { attempts: m.retries } : {}),
      ...declaredRetry,
      // The deprecated spelling, resolved the way the step leaf resolves it:
      // `initialDelay` wins when both are present. Applied AFTER the spread so a
      // policy carrying only `delay` does not silently keep the default.
      ...(declaredRetry?.initialDelay === undefined && declaredRetry?.delay !== undefined
        ? { initialDelay: parseDurationMs(declaredRetry.delay) }
        : {}),
    };

    // Classification sees the same scope in both fields, and `retryOn` is
    // consulted only for what `success` rejected — so a status named by both is a
    // success, and nothing has to say which wins.
    const evaluate = (expr: unknown, scope: Record<string, unknown>): unknown =>
      ctx.expandValue(expr, { ...callerInput, ...scope });
    const isSuccess = classifier("success", m.success, evaluate, (status) => status < 400);
    const isRetryable = classifier("retryOn", m.retryOn, evaluate, (status) =>
      DEFAULT_RETRY_STATUSES.includes(status),
    );

    // Build URL
    const baseUrl = rawUrl.startsWith("http") ? rawUrl : `${clientBaseUrl}${rawUrl}`;

    // Append query params — the credential may contribute more (an API key in a
    // query parameter), so the URL is assembled per attempt rather than once.
    const buildUrl = (extraQuery?: Record<string, string>): string => {
      // Same precedence as headers: the request's own query wins over the credential's.
      const entries = Object.entries({ ...(extraQuery ?? {}), ...query });
      if (entries.length === 0) return baseUrl;
      const params = new URLSearchParams(entries);
      return `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}${params.toString()}`;
    };

    // Merge headers: client defaults < request-specific
    const mergedHeaders: Record<string, string> = { ...clientHeaders, ...requestHeaders };

    // Headers DERIVED from the body rather than declared by anyone. Kept in their
    // own map and filled in last, only where nothing else set the key: the
    // credential path rebuilds the header set from the client/request maps, so a
    // value mutated into `mergedHeaders` here would be silently dropped from every
    // authenticated request that carries a body.
    const derivedHeaders: Record<string, string> = {};

    // Serialize body
    const declaredContentType = mergedHeaders["content-type"];
    const { body: serializedBody, contentType: impliedContentType } = serializeBody(
      body,
      resolved.bodyEncoding,
      declaredContentType,
    );
    if (!declaredContentType && impliedContentType) {
      derivedHeaders["content-type"] = impliedContentType;
    }

    /** Fill in derived headers wherever the key is still unset. */
    const withDerived = (headers: Record<string, string>): Record<string, string> => {
      const out = { ...headers };
      for (const [key, value] of Object.entries(derivedHeaders)) {
        if (out[key] === undefined) out[key] = value;
      }
      return out;
    };

    const attempt = async (forceRefresh: boolean): Promise<{ response: TeloResponse; url: string }> => {
      let headers = withDerived(mergedHeaders);
      let url = buildUrl();
      if (applyCredential) {
        const applied = (await applyCredential(
          { request: { method, url, headers, query }, forceRefresh },
          invokeCtx,
        )) as { headers?: Record<string, string>; query?: Record<string, string> } | undefined;
        // Client defaults < credential < this request's own. An explicit per-call
        // header is the most specific statement of intent there is, so it must not
        // be silently replaced by the credential; the client's defaults are the
        // ones the credential is there to supersede. Derived headers fill in last,
        // and only where nothing above set the key.
        headers = withDerived({
          ...clientHeaders,
          ...normalizeHeaders(applied?.headers ?? {}),
          ...requestHeaders,
        });
        url = buildUrl(applied?.query);
      }
      const startedAt = Date.now();
      const response = await executeWithRetry({
        url,
        method,
        headers,
        body: serializedBody,
        timeout: effectiveTimeout,
        retry,
        log: ctx.log,
        responseType,
        isSuccess,
        isRetryable,
        callerSignal: invokeCtx?.cancellation.signal,
      });
      if (ctx.log.enabled(SEVERITY.debug)) {
        ctx.log.debug("Request completed", {
          "http.request.method": method,
          ...urlAttributes(url),
          "http.response.status_code": response.status,
          // OTel's name and OTel's unit — SECONDS, as a double. See the note in
          // sql-connection-base: the name is safe to reuse, the wrong magnitude
          // under it is not.
          "http.client.request.duration": (Date.now() - startedAt) / 1000,
        });
      }
      return { response, url };
    };

    let { response, url: fullUrl } = await attempt(false);

    // A header is computed before the call, so it cannot react to a token the
    // server has just rejected. Asking the credential to re-acquire and retrying
    // once lives here rather than in each credential kind, so every scheme
    // inherits it. Exactly one retry — a second rejection propagates.
    if (response.status === 401 && applyCredential) {
      // `info`: the caller sees only the second response, so a credential that
      // needs re-acquiring on every call — a token TTL shorter than the client
      // believes — looks identical to one that never expires.
      ctx.log.info("Server rejected the credential; re-acquiring and retrying once", {
        "http.request.method": method,
        ...urlAttributes(fullUrl),
      });
      // This re-send is not governed by `retry` — it is the credential contract,
      // and it fires even at `attempts: 0` — so a non-replayable body has to be
      // refused here too, or the retry would send an empty payload with a fresh
      // token and be answered 200.
      assertReplayable(serializedBody, fullUrl);
      if (responseType === "stream") (response.body as PassThrough | undefined)?.destroy();
      ({ response, url: fullUrl } = await attempt(true));
    }

    if (throwOnHttpError && !isSuccess(response.status, response.headers, response.body)) {
      // The provider's own explanation is IN the body, and under
      // `responseType: stream` that body is an unread PassThrough — so a
      // streamed call used to raise a status line and nothing else, in exactly
      // the case where the message matters most: a model refusing a request
      // says why, and "HTTP 400" does not.
      const detail = await failureDetail(response.body, responseType);
      throw new InvokeError(
        ERR_HTTP_STATUS,
        detail
          ? `HTTP ${response.status} error from ${fullUrl}: ${detail}`
          : `HTTP ${response.status} error from ${fullUrl}`,
        {
          status: response.status,
          url: fullUrl,
          ...(detail === undefined ? {} : { body: detail }),
        },
      );
    }

    if (responseType === "stream") {
      // The stream is returned in `body`, the same slot every other response type
      // fills, so a streamed call has ONE output shape with the rest. Returning
      // `{output}` instead contradicted the kind's own declared contract — which
      // requires status/headers/body — so every streamed call failed
      // ERR_OUTPUT_INVALID and `result.output` was a static unknown field. The
      // alternative, a union of two output shapes, would degrade `status` and
      // `headers` to untyped at every call site to describe a mode most calls
      // never use.
      // Wrapped in a Stream so the value's constructor is the one CEL has
      // registered. Consumers pipe it through a codec encoder (Octet.Encoder for
      // raw bytes) or iterate it.
      return { ...response, body: new Stream(response.body as Readable) };
    }

    return response;
  }
}

export function register(): void {}

export async function create(
  resource: HttpRequestManifest,
  ctx: ResourceContext,
): Promise<HttpRequestResource> {
  return new HttpRequestResource(resource, ctx);
}
