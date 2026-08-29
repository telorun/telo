/**
 * Multimodal message content — the provider-neutral shape shared by message inputs
 * and tool results. A message's `content` is either a plain string (the common,
 * back-compatible case) or an array of content parts.
 *
 * An image part's `data` is bytes (`Uint8Array`, the stdlib binary convention — what
 * a rasterizer/overlay tool result naturally produces) OR a base64 string (what a
 * manifest-authored message carries, since YAML/JSON can't hold bytes). Provider
 * translation normalizes either form to its own wire shape (e.g. a base64 data URL).
 */

export type TextPart = { type: "text"; text: string };
export type ImagePart = { type: "image"; data: Uint8Array | string; mediaType: string };

/** A media part that is not an image — audio, video, a document. Same carriage
 *  as an image (bytes, or a URI when they are referenced rather than sent), so
 *  a document is a matter of VALUE rather than of a separate kind. */
export type MediaPart = {
  type: "audio" | "video" | "file";
  data?: Uint8Array | string;
  uri?: string;
  mediaType: string;
};

/** Parts a model produces and a caller does not send. Kept in the same union
 *  because they travel in the same list: an answer carrying reasoning beside its
 *  text is one `content`, not two. */
export type ReasoningPart = { type: "reasoning"; text: string };
export type RefusalPart = { type: "refusal"; text: string };
export type CitationPart = { type: "citation"; citation: Record<string, unknown> };
export type ToolCallPart = {
  type: "tool-call";
  toolCall: { id: string; name: string; arguments: Record<string, unknown> };
};

export type ContentPart =
  | TextPart
  | ImagePart
  | MediaPart
  | ReasoningPart
  | RefusalPart
  | CitationPart
  | ToolCallPart;
export type MessageContent = string | ContentPart[];

export function isTextPart(v: unknown): v is TextPart {
  return (
    !!v &&
    typeof v === "object" &&
    (v as { type?: unknown }).type === "text" &&
    typeof (v as { text?: unknown }).text === "string"
  );
}

export function isImagePart(v: unknown): v is ImagePart {
  if (!v || typeof v !== "object" || (v as { type?: unknown }).type !== "image") return false;
  const data = (v as { data?: unknown }).data;
  const mediaType = (v as { mediaType?: unknown }).mediaType;
  return (typeof data === "string" || data instanceof Uint8Array) && typeof mediaType === "string";
}

/**
 * A part is content when its `type` is one the vocabulary declares AND it
 * carries what that type requires.
 *
 * The required-field check is the whole point. A predicate that accepted any
 * object with a known `type` would admit `{type: "text"}` with no text and
 * `{type: "image"}` with no bytes — which the two dedicated predicates below
 * reject, so widening the vocabulary that way would have made this LOOSER than
 * before while claiming to keep arbitrary objects out of a message.
 */
export function isContentPart(v: unknown): v is ContentPart {
  if (!v || typeof v !== "object") return false;
  const part = v as Record<string, unknown>;
  switch (part.type) {
    case "text":
      return isTextPart(v);
    case "image":
      return isImagePart(v);
    case "audio":
    case "video":
    case "file":
      // Bytes or a URI, and always a media type — the carriage a consumer needs
      // to do anything at all with it.
      return (
        typeof part.mediaType === "string" &&
        (typeof part.data === "string" ||
          part.data instanceof Uint8Array ||
          typeof part.uri === "string")
      );
    case "reasoning":
    case "refusal":
      return typeof part.text === "string";
    case "citation":
      return !!part.citation && typeof part.citation === "object";
    case "tool-call":
      return !!part.toolCall && typeof part.toolCall === "object";
    default:
      return false;
  }
}

/** True when `v` is a non-empty array of content parts — the shape a multimodal
 *  tool result or message content takes. An empty array is not treated as content
 *  parts (it carries nothing, so it falls through to plain serialization). */
export function isContentParts(v: unknown): v is ContentPart[] {
  return Array.isArray(v) && v.length > 0 && v.every(isContentPart);
}

/** Flatten content to its text — concatenating the text parts, ignoring image
 *  parts. Used where only text is meaningful (echo fixture, a system message that
 *  cannot carry images, the assistant turn paired with tool calls). */
export function contentToText(content: MessageContent | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .filter(isTextPart)
    .map((p) => p.text)
    .join("");
}
