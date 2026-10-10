import {
  ERR_INVOKE_CANCELLED,
  InvokeError,
  integerInput,
  isAmbientContractErrorCode,
  isCancellationError,
  isSuspension,
  type InvokeContext,
} from "@telorun/sdk";

/**
 * The failures a language model may raise — the `throws:` list `Ai.Model` and
 * `Ai.ModelStream` declare, which every provider kind restates in full.
 *
 * One constructor per code, so a provider never spells a code or shapes its
 * `data` by hand, plus what every provider shares: the HTTP status rows, the
 * `Retry-After` header, and the boundary that decides which errors leave a model
 * kind as they are. Vendor error names and transport error classes stay with
 * each provider, which is the module that knows them.
 */

/** The thirteen codes, in the order the abstracts declare them. */
export const MODEL_FAILURE_CODES = [
  "ERR_MODEL_ACCESS_DENIED",
  "ERR_MODEL_RATE_LIMITED",
  "ERR_MODEL_QUOTA_EXCEEDED",
  "ERR_MODEL_UNAVAILABLE",
  "ERR_MODEL_TIMEOUT",
  "ERR_MODEL_UNREACHABLE",
  "ERR_MODEL_CONTEXT_TOO_LONG",
  "ERR_MODEL_CONTENT_REFUSED",
  "ERR_MODEL_REQUEST_REJECTED",
  "ERR_MODEL_CONTENT_UNSUPPORTED",
  "ERR_MODEL_TOOL_ARGUMENTS_INVALID",
  "ERR_MODEL_RESPONSE_INVALID",
  "ERR_INVALID_REFERENCE",
] as const;

export type ModelFailureCode = (typeof MODEL_FAILURE_CODES)[number];

/** What a re-coded failure keeps of the error it replaces. */
export interface ModelFailureOptions {
  cause?: unknown;
}

/** `status` is present only when an HTTP response carried the failure. */
export interface ModelStatusData {
  status?: number;
}

/** `retryAfterSeconds` is what a standard `Retry-After` header asked for. */
export interface ModelRetryData extends ModelStatusData {
  retryAfterSeconds?: number;
}

export interface ModelContentUnsupportedData {
  /** The `type` of the content part that was refused. */
  partType: string;
  /** The lowercased scheme of the part's `uri`, when the scheme is the reason. */
  scheme?: string;
  /** The part's media type, when it has one. */
  mediaType?: string;
}

export interface ModelToolArgumentsInvalidData {
  /** The tool the model asked for. */
  tool: string;
}

function failure(
  code: ModelFailureCode,
  message: string,
  data: object | undefined,
  options: ModelFailureOptions | undefined,
): InvokeError {
  const cause = options && "cause" in options ? { cause: options.cause } : undefined;
  return new InvokeError(code, message, data, cause);
}

function statusData(data: ModelStatusData | undefined): ModelStatusData {
  return data?.status === undefined ? {} : { status: data.status };
}

function retryData(data: ModelRetryData | undefined): ModelRetryData {
  return {
    ...statusData(data),
    ...(data?.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: data.retryAfterSeconds }),
  };
}

/** The credential was refused, or it has no permission for the model. */
export function modelAccessDenied(
  message: string,
  data?: ModelStatusData,
  options?: ModelFailureOptions,
): InvokeError {
  return failure("ERR_MODEL_ACCESS_DENIED", message, statusData(data), options);
}

/** The endpoint asked the caller to slow down. */
export function modelRateLimited(
  message: string,
  data?: ModelRetryData,
  options?: ModelFailureOptions,
): InvokeError {
  return failure("ERR_MODEL_RATE_LIMITED", message, retryData(data), options);
}

/** The account's credit or plan is exhausted. */
export function modelQuotaExceeded(
  message: string,
  data?: ModelStatusData,
  options?: ModelFailureOptions,
): InvokeError {
  return failure("ERR_MODEL_QUOTA_EXCEEDED", message, statusData(data), options);
}

/** The provider is overloaded or failing on its side. */
export function modelUnavailable(
  message: string,
  data?: ModelRetryData,
  options?: ModelFailureOptions,
): InvokeError {
  return failure("ERR_MODEL_UNAVAILABLE", message, retryData(data), options);
}

/** No complete response arrived in time; whether the request ran is unknown. */
export function modelTimeout(
  message: string,
  data?: ModelStatusData,
  options?: ModelFailureOptions,
): InvokeError {
  return failure("ERR_MODEL_TIMEOUT", message, statusData(data), options);
}

/** Nothing answered: a refused connection, a name that did not resolve, a failed handshake. */
export function modelUnreachable(message: string, options?: ModelFailureOptions): InvokeError {
  return failure("ERR_MODEL_UNREACHABLE", message, undefined, options);
}

/** The input exceeds the model's context window or the endpoint's request size limit. */
export function modelContextTooLong(
  message: string,
  data?: ModelStatusData,
  options?: ModelFailureOptions,
): InvokeError {
  return failure("ERR_MODEL_CONTEXT_TOO_LONG", message, statusData(data), options);
}

/** The endpoint rejected the request on content-policy grounds. */
export function modelContentRefused(
  message: string,
  data?: ModelStatusData,
  options?: ModelFailureOptions,
): InvokeError {
  return failure("ERR_MODEL_CONTENT_REFUSED", message, statusData(data), options);
}

/** The endpoint refused the request as one it cannot serve, or the provider
 *  refused it before sending. Also the terminal default for a failure nothing
 *  else classifies. */
export function modelRequestRejected(
  message: string,
  data?: ModelStatusData,
  options?: ModelFailureOptions,
): InvokeError {
  return failure("ERR_MODEL_REQUEST_REJECTED", message, statusData(data), options);
}

/** A well-formed content part this endpoint cannot carry; raised before anything is sent. */
export function modelContentUnsupported(
  message: string,
  data: ModelContentUnsupportedData,
  options?: ModelFailureOptions,
): InvokeError {
  return failure(
    "ERR_MODEL_CONTENT_UNSUPPORTED",
    message,
    {
      partType: data.partType,
      ...(data.scheme === undefined ? {} : { scheme: data.scheme }),
      ...(data.mediaType === undefined ? {} : { mediaType: data.mediaType }),
    },
    options,
  );
}

/** The model asked for a tool with arguments that are not a JSON object. */
export function modelToolArgumentsInvalid(
  message: string,
  data: ModelToolArgumentsInvalidData,
  options?: ModelFailureOptions,
): InvokeError {
  return failure("ERR_MODEL_TOOL_ARGUMENTS_INVALID", message, { tool: data.tool }, options);
}

/** The endpoint reported success but the answer cannot be read. */
export function modelResponseInvalid(message: string, options?: ModelFailureOptions): InvokeError {
  return failure("ERR_MODEL_RESPONSE_INVALID", message, undefined, options);
}

/** A resource the model depends on did not resolve to a live instance. */
export function modelInvalidReference(message: string, options?: ModelFailureOptions): InvokeError {
  return failure("ERR_INVALID_REFERENCE", message, undefined, options);
}

/**
 * What a standard `Retry-After` header asks for, in whole seconds rounded up.
 *
 * Delta-seconds, or an HTTP date read as seconds from now. Absent for anything
 * else — empty or unparseable text, a negative or non-finite number, a date that
 * is not in the future — because a zero there would read as "retry at once",
 * which the endpoint did not say.
 */
export function retryAfterSeconds(text: string | undefined | null): number | undefined {
  if (typeof text !== "string") return undefined;
  const value = text.trim();
  if (value === "") return undefined;
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(value)) {
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : undefined;
  }
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  const delta = at - Date.now();
  return delta > 0 ? Math.ceil(delta / 1000) : undefined;
}

/**
 * The failure an HTTP status alone names — the rows every provider shares.
 *
 * A provider consults its own vendor error names first and falls to this.
 * `retryAfter` is the `Retry-After` header's text, carried on a rate limit and on
 * an unavailable endpoint. A status outside the client- and server-error classes
 * (an unfollowed redirect, a success the caller's own rule refused) is a request
 * the endpoint did not serve; one that is absent or not a status carries none.
 */
export function modelFailureFromStatus(
  status: unknown,
  message: string,
  options?: ModelFailureOptions & { retryAfter?: string | null },
): InvokeError {
  // A status read off another resource's declared-integer output arrives as an
  // int64, so both representations are read.
  const code = integerInput(status);
  if (code === undefined || code < 100 || code > 599) {
    return modelRequestRejected(message, undefined, options);
  }
  return fromStatus(code, message, options);
}

function fromStatus(
  status: number,
  message: string,
  options: (ModelFailureOptions & { retryAfter?: string | null }) | undefined,
): InvokeError {
  const data: ModelStatusData = { status };
  const retry = (): ModelRetryData => ({
    status,
    retryAfterSeconds: retryAfterSeconds(options?.retryAfter),
  });
  if (status === 401 || status === 403) return modelAccessDenied(message, data, options);
  if (status === 402) return modelQuotaExceeded(message, data, options);
  if (status === 429) return modelRateLimited(message, retry(), options);
  if (status === 408 || status === 504) return modelTimeout(message, data, options);
  if (status === 413) return modelContextTooLong(message, data, options);
  if (status >= 500) return modelUnavailable(message, retry(), options);
  return modelRequestRejected(message, data, options);
}

/**
 * What an error leaving a model kind is raised as — the boundary every provider
 * passes every error of a call through. First match wins:
 *
 *   1. a cancelled invocation stays a cancellation, never a model failure: a
 *      structured one is returned as it is, a raw abort becomes
 *      `ERR_INVOKE_CANCELLED` with the abort as its cause;
 *   2. a durable suspension is returned as it is;
 *   3. a contract error of the dispatch is returned as it is;
 *   4. a failure that is already one of the model codes is returned as it is;
 *   5. anything else is what `otherwise` says it is — one of the thirteen, built
 *      with a constructor above and keeping the error as its cause.
 *
 * `otherwise` is the provider's own: its transport's rejection vocabulary, then
 * the default of the phase the call was in. It is called at most once.
 */
export function modelFailureFromError(
  err: unknown,
  ctx: InvokeContext | undefined,
  otherwise: (err: unknown) => InvokeError,
): unknown {
  if (isCancellationError(err)) return err;
  if (ctx?.cancellation?.signal?.aborted === true) {
    return new InvokeError(ERR_INVOKE_CANCELLED, "Invoke cancelled", undefined, { cause: err });
  }
  if (isSuspension(err)) return err;
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string") {
    if (isAmbientContractErrorCode(code)) return err;
    if ((MODEL_FAILURE_CODES as readonly string[]).includes(code)) return err;
  }
  return otherwise(err);
}
