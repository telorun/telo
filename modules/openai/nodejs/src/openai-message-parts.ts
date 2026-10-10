import {
  modelContentUnsupported,
  modelToolArgumentsInvalid,
  type ContentPart,
  type MediaPart,
} from "@telorun/ai";
import type { InvokeError } from "@telorun/sdk";

/**
 * Message-content translation shared by both dialects.
 *
 * These are the pieces that do NOT differ between `/chat/completions` and
 * `/v1/responses`: how bytes become a data URL, what a file sent by bytes must
 * carry, which URIs an endpoint can be handed, how a part the dialect cannot
 * carry is refused, and how a model's tool arguments are read back. Each
 * dialect still owns its own wire shapes — its own answer to WHICH parts it
 * carries, and to where a tool result's media goes.
 */

/** A media part's bytes as a data URL. Runtime tool results carry raw bytes (the
 *  stdlib binary convention); manifest-authored parts carry a base64 string. */
export function dataUrl(part: MediaPart & { data: Uint8Array | string }): string {
  const base64 =
    typeof part.data === "string" ? part.data : Buffer.from(part.data).toString("base64");
  return `data:${part.mediaType};base64,${base64}`;
}

const NEEDS_NAME = "A file sent by bytes needs 'name' on this endpoint.";

/** A file's bytes with the file name both dialects send beside them. A file
 *  with no name is refused: the endpoint cannot tell what it was handed. */
export function namedFileData(
  part: MediaPart & { data: Uint8Array | string },
  label: string,
): { filename: string; file_data: string } {
  if (part.name === undefined) throw contentUnsupported(label, part, NEEDS_NAME);
  return { filename: part.name, file_data: dataUrl(part) };
}

/**
 * The refusal of a well-formed part this dialect cannot carry.
 *
 * Raised while the request is BUILT, before anything is sent: sending the rest
 * would be a request quietly missing part of the message. `takes` says what the
 * endpoint accepts instead; `scheme` is set when the URI's scheme is the reason.
 */
export function contentUnsupported(
  label: string,
  part: ContentPart,
  takes: string,
  scheme?: string,
): InvokeError {
  const mediaType = "mediaType" in part ? part.mediaType : undefined;
  const ofType = mediaType === undefined ? "" : ` of media type '${mediaType}'`;
  const carriage = scheme === undefined ? "" : ` by a '${scheme}:' URI`;
  return modelContentUnsupported(
    `${label}: a '${part.type}' content part${ofType} cannot be sent${carriage}. ${takes}`,
    { partType: part.type, scheme, mediaType },
  );
}

/** What a model-produced part is told when it is submitted as input. */
export const OUTPUT_ONLY = "It is produced by a model, not submitted to one.";

/**
 * A media part's `uri`, when it is one an endpoint can be handed: `http:` or
 * `https:`. Returned exactly as written — a reference is translated, never
 * fetched. Any other scheme names something only this machine could resolve,
 * and is refused with that scheme.
 */
export function remoteUrl(
  part: MediaPart & { uri: string },
  label: string,
  takes: string,
): string {
  const scheme = part.uri.slice(0, part.uri.indexOf(":")).toLowerCase();
  if (scheme === "http" || scheme === "https") return part.uri;
  throw contentUnsupported(label, part, takes, scheme);
}

/**
 * A tool call's `arguments` member as the JSON text it arrives as, `undefined`
 * when the call carries none. Anything else there is raised, never read as a
 * call with no arguments.
 */
export function toolArgumentsText(raw: unknown, toolName: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") return raw;
  throw modelToolArgumentsInvalid(
    `OpenAI tool call '${toolName}' returned arguments that are not a JSON string: ` +
      `${JSON.stringify(raw)}`,
    { tool: toolName },
  );
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
export function parseToolArguments(given: unknown, toolName: string): Record<string, unknown> {
  const raw = toolArgumentsText(given, toolName);
  if (!raw || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw modelToolArgumentsInvalid(
      `OpenAI tool call '${toolName}' returned arguments that are not JSON: ${raw}`,
      { tool: toolName },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw modelToolArgumentsInvalid(
      `OpenAI tool call '${toolName}' arguments were not a JSON object: ${raw}`,
      { tool: toolName },
    );
  }
  return parsed as Record<string, unknown>;
}
