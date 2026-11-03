import type { MessageValue } from "@telorun/message-format";
import { problemOf } from "./problem-details.js";
import type { Say } from "./texts.js";

/** One of the renderer's own texts, by key, with the values it is formatted with. */
export interface OwnText {
  key: string;
  values?: Readonly<Record<string, MessageValue>>;
}

/** A failure the renderer shows as an `error` node, under its code. `text`,
 *  when present, is what the message says in the application's language;
 *  `message` is what stands for it before the application's texts are known. */
export class UiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly text?: OwnText,
  ) {
    super(message);
  }
}

export interface ErrorSpec {
  type: "error";
  code: string;
  message: string;
  text?: OwnText;
}

export function errorSpec(error: unknown, fallbackCode: string): ErrorSpec {
  if (error instanceof UiError) {
    return { type: "error", code: error.code, message: error.message, ...(error.text ? { text: error.text } : {}) };
  }
  return { type: "error", code: fallbackCode, message: error instanceof Error ? error.message : String(error) };
}

/** The code and text a failed status stands for when its body names neither. */
function statusFailure(status: number): { code: string; text: OwnText } {
  if (status === 401) return { code: "ERR_UI_UNAUTHORIZED", text: { key: "requestUnauthorized" } };
  if (status === 403) return { code: "ERR_UI_FORBIDDEN", text: { key: "requestForbidden" } };
  return { code: "ERR_UI_REQUEST_FAILED", text: { key: "requestFailedStatus", values: { status } } };
}

/**
 * What a response that is not a success means: its problem's `code` and
 * `detail` where it gives them, else what the status stands for — 401 and 403
 * with codes of their own, anything else a failed request.
 */
export async function responseError(response: Response): Promise<UiError> {
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    // The body is not JSON; the status alone is the report.
  }
  const problem = problemOf(body);
  const fallback = statusFailure(response.status);
  const code = problem.code ?? fallback.code;
  return problem.detail !== undefined
    ? new UiError(code, problem.detail)
    : new UiError(code, String(response.status), fallback.text);
}

/** A request that got no response at all. */
export function networkError(error: unknown): UiError {
  if (error instanceof UiError) return error;
  const reason = error instanceof Error ? error.message : String(error);
  return new UiError("ERR_UI_REQUEST_FAILED", reason, { key: "requestFailed", values: { reason } });
}

/** What a request that did not succeed reads as: `status` absent when nothing
 *  answered, `code` and `message` the problem's `code` and `detail`. */
export interface RequestError {
  status?: number;
  code?: string;
  message?: string;
}

/** A response that is not a success, read with the body it carried: the
 *  problem's `code` and `detail` where it gives them, else what the status means. */
export function requestErrorOf(status: number, body: unknown, say: Say): RequestError {
  const problem = problemOf(body);
  const fallback = statusFailure(status);
  return {
    status,
    code: problem.code ?? fallback.code,
    message: problem.detail ?? say(fallback.text.key, fallback.text.values),
  };
}

/** A request that got no answer at all. */
export function unansweredError(error: unknown, say: Say): RequestError {
  return {
    code: "ERR_UI_REQUEST_FAILED",
    message: say("requestFailed", { reason: error instanceof Error ? error.message : String(error) }),
  };
}
