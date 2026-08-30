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

/**
 * `responseFormat` is ONE contract field with two incompatible wire shapes.
 *
 * The declared `Ai.Model` input is an open object, so nothing static or runtime
 * catches the difference — and the two APIs disagree in both directions. Chat
 * nests the schema (`{type: json_schema, json_schema: {name, schema, strict}}`)
 * and refuses the flat form with `Missing required parameter:
 * 'response_format.json_schema'`; responses takes it flat and refuses the nested
 * form with `Missing required parameter: 'text.format.name'`. Both verified
 * against the live endpoints.
 *
 * So each dialect NORMALIZES rather than passing through. Without it, swapping
 * `OpenAI.ChatModel` for `OpenAI.ResponsesModel` — which the docs present as an
 * interchangeable choice under one abstract — turns a working manifest into a
 * provider 400 with no Telo diagnostic.
 *
 * Only `json_schema` differs. `{type: text}`, `{type: json_object}` and anything
 * this module has not heard of pass through untouched, so a format the endpoint
 * gains tomorrow is not blocked by a translation written today.
 */

function isJsonSchemaFormat(value: Record<string, unknown>): boolean {
  return value.type === "json_schema";
}

/** Nest a flat `json_schema` format, which is what `/chat/completions` takes. */
export function toChatResponseFormat(value: Record<string, unknown>): Record<string, unknown> {
  if (!isJsonSchemaFormat(value) || value.json_schema !== undefined) return value;
  const { type, ...rest } = value;
  return { type, json_schema: rest };
}

/** Flatten a nested `json_schema` format, which is what `/v1/responses` takes. */
export function toResponsesTextFormat(value: Record<string, unknown>): Record<string, unknown> {
  if (!isJsonSchemaFormat(value)) return value;
  const nested = value.json_schema;
  if (!nested || typeof nested !== "object") return value;
  return { type: value.type, ...(nested as Record<string, unknown>) };
}
