/** A failure the renderer shows as an `error` node, under its code. */
export class UiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ErrorSpec {
  type: "error";
  code: string;
  message: string;
}

export function errorSpec(error: unknown, fallbackCode: string): ErrorSpec {
  if (error instanceof UiError) return { type: "error", code: error.code, message: error.message };
  return { type: "error", code: fallbackCode, message: error instanceof Error ? error.message : String(error) };
}

/**
 * What a response that is not a success means. 401 and 403 have codes of their
 * own; anything else is a failed request, reported with its status.
 */
export async function responseError(response: Response): Promise<UiError> {
  if (response.status === 401) return new UiError("ERR_UI_UNAUTHORIZED", "You are not signed in, or your session has ended.");
  if (response.status === 403) return new UiError("ERR_UI_FORBIDDEN", "You are not allowed to do this.");
  let detail = "";
  try {
    const body = await response.clone().json();
    if (typeof body?.message === "string") detail = `: ${body.message}`;
  } catch {
    // The body is not JSON; the status alone is the report.
  }
  return new UiError("ERR_UI_REQUEST_FAILED", `The request failed with status ${response.status}${detail}`);
}

/** A request that got no response at all. */
export function networkError(error: unknown): UiError {
  if (error instanceof UiError) return error;
  return new UiError("ERR_UI_REQUEST_FAILED", `The request failed: ${error instanceof Error ? error.message : String(error)}`);
}
