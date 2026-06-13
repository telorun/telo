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
export type ContentPart = TextPart | ImagePart;
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

export function isContentPart(v: unknown): v is ContentPart {
  return isTextPart(v) || isImagePart(v);
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
