import {
  modelAccessDenied,
  modelContentRefused,
  modelContextTooLong,
  modelFailureFromStatus,
  modelQuotaExceeded,
  modelRateLimited,
  modelRequestRejected,
  modelResponseInvalid,
  modelTimeout,
  modelUnavailable,
  modelUnreachable,
  retryAfterSeconds,
} from "@telorun/ai";
import { InvokeError, integerInput } from "@telorun/sdk";

/**
 * How a failure of this vendor's endpoints becomes one of the codes `Ai.Model`
 * declares.
 *
 * Two readers, each used wherever its input turns up: the vendor's own error
 * object (a failed response's body, a success body that carries one, a stream
 * frame, a failed run) and a rejection of the injected request. Which errors
 * leave a model kind as they are — a cancellation, a suspension, a contract
 * error, a failure already classified — is `modelFailureFromError`'s to say, in
 * `@telorun/ai`; what is here is what that boundary asks about the rest.
 */

/** The vendor's error object, as much of it as classification reads. */
export interface VendorError {
  code?: string;
  type?: string;
  message?: string;
}

/** What an HTTP response adds to a failure it carried. */
export interface CarriedBy {
  status: unknown;
  /** The `Retry-After` header's text, when the response is in hand. */
  retryAfter?: string | null;
}

type FailureClass =
  | "access"
  | "quota"
  | "rate"
  | "context"
  | "content"
  | "timeout"
  | "rejected"
  | "unavailable";

/** Names the vendor gives one failure, matched against an error's `code` and
 *  its `type`. These win over the status. */
const SPECIFIC: Record<string, FailureClass> = {
  invalid_api_key: "access",
  account_deactivated: "access",
  insufficient_quota: "quota",
  billing_hard_limit_reached: "quota",
  billing_not_active: "quota",
  rate_limit_exceeded: "rate",
  context_length_exceeded: "context",
  content_policy_violation: "content",
  content_filter: "content",
  moderation_blocked: "content",
  image_content_policy_violation: "content",
  vector_store_timeout: "timeout",
  invalid_prompt: "rejected",
  model_not_found: "rejected",
  invalid_image: "rejected",
  invalid_image_format: "rejected",
  invalid_base64_image: "rejected",
  invalid_image_url: "rejected",
  invalid_image_mode: "rejected",
  image_too_large: "rejected",
  image_too_small: "rejected",
  image_parse_error: "rejected",
  image_file_too_large: "rejected",
  unsupported_image_media_type: "rejected",
  empty_image_file: "rejected",
  failed_to_download_image: "rejected",
  image_file_not_found: "rejected",
  server_error: "unavailable",
};

/** Error families, read only when no status carried the failure: a family may
 *  not override a status, or a 401 typed as an invalid request would be read as
 *  one. */
const GENERIC: Record<string, FailureClass> = {
  authentication_error: "access",
  permission_error: "access",
  rate_limit_error: "rate",
  invalid_request_error: "rejected",
  not_found_error: "rejected",
  api_error: "unavailable",
  overloaded_error: "unavailable",
};

/** A table's entry under a name the endpoint sent. Own entries only: a name such
 *  as `constructor` is a member of every object and names no failure. */
function named(table: Record<string, FailureClass>, name: string | undefined): FailureClass | undefined {
  return name !== undefined && Object.hasOwn(table, name) ? table[name] : undefined;
}

function integerStatus(status: unknown): number | undefined {
  const code = integerInput(status);
  return code !== undefined && code >= 100 && code <= 599 ? code : undefined;
}

function build(
  kind: FailureClass,
  message: string,
  carried: CarriedBy | undefined,
  cause: { cause?: unknown },
): InvokeError {
  const status = integerStatus(carried?.status);
  const data = status === undefined ? {} : { status };
  const retry = { ...data, retryAfterSeconds: retryAfterSeconds(carried?.retryAfter) };
  switch (kind) {
    case "access":
      return modelAccessDenied(message, data, cause);
    case "quota":
      return modelQuotaExceeded(message, data, cause);
    case "rate":
      return modelRateLimited(message, retry, cause);
    case "context":
      return modelContextTooLong(message, data, cause);
    case "content":
      return modelContentRefused(message, data, cause);
    case "timeout":
      return modelTimeout(message, data, cause);
    case "rejected":
      return modelRequestRejected(message, data, cause);
    case "unavailable":
      return modelUnavailable(message, retry, cause);
  }
}

/**
 * The failure an error object names, in a fixed order: a specific vendor name,
 * then the status when a response carried the failure, then the error's family,
 * then "unavailable".
 */
export function vendorFailure(
  message: string,
  error: VendorError | undefined,
  carried?: CarriedBy,
  options: { cause?: unknown } = {},
): InvokeError {
  const cause = "cause" in options ? { cause: options.cause } : {};
  const specific = named(SPECIFIC, error?.code) ?? named(SPECIFIC, error?.type);
  if (specific) return build(specific, message, carried, cause);
  if (carried) {
    return modelFailureFromStatus(carried.status, message, {
      retryAfter: carried.retryAfter,
      ...cause,
    });
  }
  const generic = named(GENERIC, error?.type);
  return build(generic ?? "unavailable", message, undefined, cause);
}

/** The vendor's error object out of a decoded body, frame or event — `undefined`
 *  when it carries none. */
export function vendorErrorOf(value: unknown): VendorError | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
  const { code, type, message } = error as Record<string, unknown>;
  return {
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof type === "string" ? { type } : {}),
    ...(typeof message === "string" ? { message } : {}),
  };
}

/** The same, out of body text that may or may not be the vendor's JSON. */
export function vendorErrorInText(text: unknown): VendorError | undefined {
  if (typeof text !== "string") return vendorErrorOf(text);
  try {
    return vendorErrorOf(JSON.parse(text));
  } catch {
    // Not JSON: there is no vendor error to read, and the status decides.
    return undefined;
  }
}

const MAX_DETAIL = 2048;

/** What a failed response said, for the message: the vendor's own words, or the
 *  start of the body. */
function detail(error: VendorError | undefined, body: unknown): string {
  if (error?.message) return error.message;
  if (typeof body === "string" && body.trim() !== "") return body.slice(0, MAX_DETAIL);
  return "The response carried no explanation.";
}

/** The failure of a response whose status says the request was not served. */
export function responseFailure(
  label: string,
  carried: CarriedBy,
  body: unknown,
  options: { cause?: unknown } = {},
): InvokeError {
  const error = vendorErrorInText(body);
  const status = integerStatus(carried.status);
  const answered =
    status === undefined ? "the request was refused" : `the endpoint answered ${status}`;
  return vendorFailure(`${label}: ${answered}. ${detail(error, body)}`, error, carried, options);
}

/** The failure an error object reports when no status carried it: in a success
 *  body, a stream frame, or a run the endpoint accepted and then failed. */
export function reportedFailure(
  label: string,
  what: string,
  error: VendorError | undefined,
): InvokeError {
  return vendorFailure(
    `${label}: ${what}. ${error?.message ?? "The endpoint gave no reason."}`,
    error,
  );
}

function codeOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * What a rejection of the injected request is raised as, once the boundary has
 * passed what is not a model failure. First match wins:
 *
 *   1. a refused status (the request's own `throwOnHttpError`) is classified
 *      from its status and body;
 *   2. a network failure is a timeout or an unreachable endpoint;
 *   3. a credential holding no material is an access failure;
 *   4. anything else is a request that was not served — terminal, because a
 *      model call is not known to be unsent and may not be asserted transient.
 *
 * The original is kept as the cause.
 */
export function requestRejection(label: string, err: unknown): InvokeError {
  const code = codeOf(err);
  const cause = { cause: err };
  if (err instanceof InvokeError && code === "ERR_HTTP_STATUS") {
    const data = (err.data ?? {}) as { status?: unknown; body?: unknown };
    return responseFailure(label, { status: data.status }, data.body, cause);
  }
  if ((err as { error?: unknown } | null | undefined)?.error === "NetworkError") {
    const message = `${label}: the request did not complete. ${messageOf(err)}`;
    return code === "TIMEOUT"
      ? modelTimeout(message, undefined, cause)
      : modelUnreachable(message, cause);
  }
  const original = `${code === undefined ? "" : `[${code}] `}${messageOf(err)}`;
  if (code === "ERR_INVALID_CREDENTIAL") {
    return modelAccessDenied(
      `${label}: the request's credential could not be applied. ${original}`,
      undefined,
      cause,
    );
  }
  return modelRequestRejected(
    `${label}: the request could not be made. ${original}`,
    undefined,
    cause,
  );
}

/** An error raised while the request was being put together, before anything
 *  was sent. */
export function requestUnbuilt(label: string, err: unknown): InvokeError {
  return modelRequestRejected(
    `${label}: the request could not be built. ${messageOf(err)}`,
    undefined,
    { cause: err },
  );
}

/** An error raised while a success response was being read. It says the answer
 *  could not be read, not whose fault that is. */
export function answerUnreadable(label: string, err: unknown): InvokeError {
  return modelResponseInvalid(`${label}: the answer could not be read. ${messageOf(err)}`, {
    cause: err,
  });
}
