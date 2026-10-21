import type { MessageValue } from "@telorun/message-format";
import type { Say } from "./texts.js";

/** One of the renderer's own words, with the values it is formatted with. */
export interface WordCall {
  id: string;
  values?: Readonly<Record<string, MessageValue>>;
}

/** A failure the renderer shows as an `error` node, under its code. `word`,
 *  when present, is what the message says in the application's language;
 *  `message` is what stands for it before the application's words are known. */
export class UiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly word?: WordCall,
  ) {
    super(message);
  }
}

export interface ErrorSpec {
  type: "error";
  code: string;
  message: string;
  word?: WordCall;
}

export function errorSpec(error: unknown, fallbackCode: string): ErrorSpec {
  if (error instanceof UiError) {
    return { type: "error", code: error.code, message: error.message, ...(error.word ? { word: error.word } : {}) };
  }
  return { type: "error", code: fallbackCode, message: error instanceof Error ? error.message : String(error) };
}

/**
 * What a response that is not a success means. 401 and 403 have codes of their
 * own; anything else is a failed request, reported with the server's message
 * or else with its status.
 */
export async function responseError(response: Response): Promise<UiError> {
  if (response.status === 401) {
    return new UiError("ERR_UI_UNAUTHORIZED", String(response.status), { id: "requestUnauthorized" });
  }
  if (response.status === 403) return new UiError("ERR_UI_FORBIDDEN", String(response.status), { id: "requestForbidden" });
  try {
    const body = await response.clone().json();
    if (typeof body?.message === "string") return new UiError("ERR_UI_REQUEST_FAILED", body.message);
  } catch {
    // The body is not JSON; the status alone is the report.
  }
  return new UiError("ERR_UI_REQUEST_FAILED", String(response.status), {
    id: "requestFailedStatus",
    values: { status: response.status },
  });
}

/** A request that got no response at all. */
export function networkError(error: unknown): UiError {
  if (error instanceof UiError) return error;
  const reason = error instanceof Error ? error.message : String(error);
  return new UiError("ERR_UI_REQUEST_FAILED", reason, { id: "requestFailed", values: { reason } });
}

/** What a request that did not succeed reads as: `status` absent when nothing
 *  answered, `code` and `message` from a `{ code, message }` body. */
export interface RequestError {
  status?: number;
  code?: string;
  message?: string;
}

/** A response that is not a success, read with the body it carried: the
 *  body's `code` and `message` where it gives them, else what the status means. */
export function requestErrorOf(status: number, body: unknown, say: Say): RequestError {
  const answer = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const fallback =
    status === 401
      ? { code: "ERR_UI_UNAUTHORIZED", message: say("requestUnauthorized") }
      : status === 403
        ? { code: "ERR_UI_FORBIDDEN", message: say("requestForbidden") }
        : { code: "ERR_UI_REQUEST_FAILED", message: say("requestFailedStatus", { status }) };
  return {
    status,
    code: typeof answer.code === "string" ? answer.code : fallback.code,
    message: typeof answer.message === "string" ? answer.message : fallback.message,
  };
}

/** A request that got no answer at all. */
export function unansweredError(error: unknown, say: Say): RequestError {
  return {
    code: "ERR_UI_REQUEST_FAILED",
    message: say("requestFailed", { reason: error instanceof Error ? error.message : String(error) }),
  };
}
