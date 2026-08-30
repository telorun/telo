import { isImagePart, type ImagePart, type MessageContent } from "@telorun/ai";
import { InvokeError } from "@telorun/sdk";

/**
 * Message-content translation shared by both dialects.
 *
 * These are the pieces that do NOT differ between `/chat/completions` and
 * `/v1/responses`: how a picture becomes a data URL, how images are picked out
 * of a tool result, and how a model's tool arguments are read back. Each dialect
 * still owns its own wire shapes.
 *
 * Shared rather than copied because the tool-image rule below is an invariant
 * about a 400, not a formatting preference — stated twice, it drifts once.
 */

/** What a tool message says when its real answer is a picture. Neither dialect
 *  can put image bytes in a tool result — `/chat/completions` has no part
 *  vocabulary there and a responses `function_call_output` is a string — so both
 *  send this and carry the image in a synthetic `user` message flushed AFTER the
 *  whole run of tool results, never between them. Interleaving tool and user
 *  messages is a 400. */
export const TOOL_IMAGE_PLACEHOLDER = "(tool returned image content — see the following message)";

/** Render an image part as a data URL. Runtime tool results carry raw bytes (the
 *  stdlib binary convention); manifest-authored parts carry a base64 string. */
export function imageDataUrl(part: ImagePart): string {
  const base64 =
    typeof part.data === "string" ? part.data : Buffer.from(part.data).toString("base64");
  return `data:${part.mediaType};base64,${base64}`;
}

export function imageParts(content: MessageContent): ImagePart[] {
  if (typeof content === "string") return [];
  return content.filter(isImagePart);
}

/**
 * Read a model's tool-call arguments, which arrive as a JSON string.
 *
 * Raises under a DECLARED code rather than a bare `Error`: this is reachable
 * whenever a model emits malformed arguments, so a caller has to be able to name
 * it in a `catches:` and a kind has to be able to declare it. Malformed JSON is
 * surfaced rather than hidden behind an empty object — an empty-args call and a
 * broken-args call are different events.
 */
export function parseToolArguments(
  raw: string | undefined,
  toolName: string,
): Record<string, unknown> {
  if (!raw || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvokeError(
      "ERR_OPENAI_INVALID_TOOL_ARGUMENTS",
      `OpenAI tool call '${toolName}' returned arguments that are not JSON: ${raw}`,
      { tool: toolName },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvokeError(
      "ERR_OPENAI_INVALID_TOOL_ARGUMENTS",
      `OpenAI tool call '${toolName}' arguments were not a JSON object: ${raw}`,
      { tool: toolName },
    );
  }
  return parsed as Record<string, unknown>;
}
