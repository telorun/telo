/**
 * Request-parameter plumbing shared by this module's controllers (chat completions
 * and image generation). A pure function with no state — each controller bundle
 * inlines its own copy, which is exactly why nothing mutable may live here.
 */

/** Shallow-merge option layers, downstream wins. Manifest-level defaults sit
 *  beneath whatever the caller passed. */
export function mergeOptions(
  manifestOptions: Record<string, unknown> | undefined,
  callerOptions: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return { ...(manifestOptions ?? {}), ...(callerOptions ?? {}) };
}

/** Telo manifest props are camelCase; the OpenAI wire API is snake_case. Convert
 *  each top-level option key (`maxTokens` → `max_tokens`, `topP` → `top_p`).
 *  Only top-level keys are converted — values pass through untouched so nested
 *  structures (a `responseFormat` JSON schema, a `logitBias` token map) keep
 *  their own casing. Keys that are already snake_case are left unchanged. */
export function toOpenAiParams(options: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    out[snakeCase(key)] = value;
  }
  return out;
}

function snakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** Build an actionable error message from a non-OK response, preferring the
 *  provider's `{ error: { message } }` body and falling back to the raw text. */
export async function errorMessage(res: Response, label: string): Promise<string> {
  let detail = "";
  try {
    detail = await res.text();
  } catch {
    // Body already consumed or unavailable — status line is all we have.
  }
  if (detail) {
    try {
      const parsed = JSON.parse(detail) as { error?: { message?: string } };
      if (typeof parsed.error?.message === "string") detail = parsed.error.message;
    } catch {
      // Non-JSON body (gateway HTML, plain text) — keep it verbatim.
    }
  }
  return `${label} failed (${res.status} ${res.statusText})${detail ? `: ${detail}` : ""}`;
}
