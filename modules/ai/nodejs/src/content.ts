/**
 * Multimodal message content — the provider-neutral shape shared by message inputs
 * and tool results. A message's `content` is either a plain string (the common,
 * back-compatible case) or an array of content parts.
 *
 * A media part holds its bytes or names where they live, never both. `data` is
 * bytes (`Uint8Array`, the stdlib binary convention — what a rasterizer/overlay
 * tool result naturally produces) OR a base64 string (what a manifest-authored
 * message carries, since YAML/JSON can't hold bytes); `uri` is an absolute URI a
 * provider passes on as written and never fetches.
 *
 * The SHAPE of a part is `Ai.ContentPart`'s, enforced by the contract of whatever
 * takes a message. The predicates here recognise a part in a value nothing has
 * declared yet — what a tool returned — and agree with that shape, so what they
 * recognise the contract accepts.
 */

/** Marks the request from its start through this part as a prefix the caller
 *  expects to send again unchanged. A hint: a provider may honour fewer than it
 *  is given, or none, and the answer is the same either way. Legal on the parts a
 *  caller sends (text and media), never on the ones a model produces. */
export type CacheMarker = { cacheBreakpoint?: boolean };

export type TextPart = { type: "text"; text: string } & CacheMarker;

/** A system prompt: plain text, or text parts when one of them carries a cache
 *  breakpoint. The module's `SystemPrompt` shape. */
export type SystemPrompt = string | TextPart[];

/** How a media part carries its content: the bytes, or a reference to them. */
export type MediaCarriage =
  | { data: Uint8Array | string; uri?: never }
  | { uri: string; data?: never };

/** A picture, a recording, a clip or a document. One carriage for all four, so a
 *  document is a matter of VALUE rather than of a separate kind. */
export type MediaPart = {
  type: "image" | "audio" | "video" | "file";
  mediaType: string;
  /** The part's file name, where it has one. */
  name?: string;
} & MediaCarriage &
  CacheMarker;

export type ImagePart = MediaPart & { type: "image" };

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

const MEDIA_TYPES = new Set(["image", "audio", "video", "file"]);

/** The two patterns `Ai.ContentPart` holds a `uri` to: a scheme, and not `data:`. */
const HAS_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const DATA_SCHEME = /^data:/i;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array);

/** What each key `Ai.ContentPart` declares may hold. */
export const DECLARED_KEYS: Record<string, (v: unknown) => boolean> = {
  type: (v) => typeof v === "string",
  text: (v) => typeof v === "string",
  data: (v) => typeof v === "string" || v instanceof Uint8Array,
  uri: (v) => typeof v === "string" && HAS_SCHEME.test(v) && !DATA_SCHEME.test(v),
  mediaType: (v) => typeof v === "string",
  name: (v) => typeof v === "string",
  toolCall: (v) =>
    isRecord(v) &&
    Object.keys(v).every((key) => key === "id" || key === "name" || key === "arguments") &&
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    isRecord(v.arguments),
  citation: isRecord,
  cacheBreakpoint: (v) => typeof v === "boolean",
};

/** No key outside the declared set, and every key present holding what it may. */
function holdsDeclaredKeys(part: Record<string, unknown>): boolean {
  return Object.entries(part).every(([key, value]) => {
    const holds = DECLARED_KEYS[key];
    return holds !== undefined && (value === undefined || holds(value));
  });
}

/** A media part: a media type, and exactly one of bytes or an absolute URI. */
export function isMediaPart(v: unknown): v is MediaPart {
  if (!isRecord(v) || !holdsDeclaredKeys(v)) return false;
  if (typeof v.type !== "string" || !MEDIA_TYPES.has(v.type)) return false;
  if (v.mediaType === undefined) return false;
  return (v.data === undefined) !== (v.uri === undefined);
}

export function isImagePart(v: unknown): v is ImagePart {
  return isMediaPart(v) && v.type === "image";
}

/**
 * Whether a value nothing has declared — a tool's result — is a content part:
 * exactly when it satisfies `Ai.ContentPart`, so a value recognised here is
 * never refused by the contract of the model call it is sent on. Anything else
 * is data, and is written to the model as JSON.
 */
export function isContentPart(v: unknown): v is ContentPart {
  if (!isRecord(v) || !holdsDeclaredKeys(v)) return false;
  switch (v.type) {
    case "text":
      return v.text !== undefined;
    case "image":
    case "audio":
    case "video":
    case "file":
      return isMediaPart(v);
    default:
      // A part a model produces carries no cache breakpoint.
      return v.cacheBreakpoint === undefined && isOutputPart(v);
  }
}

function isOutputPart(part: Record<string, unknown>): boolean {
  switch (part.type) {
    case "reasoning":
    case "refusal":
      return part.text !== undefined;
    case "citation":
      return part.citation !== undefined;
    case "tool-call":
      return part.toolCall !== undefined;
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

/** Flatten content to its text — concatenating the text parts, ignoring media
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
