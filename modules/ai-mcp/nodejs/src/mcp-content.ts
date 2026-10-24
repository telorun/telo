import type { ContentPart } from "@telorun/ai";

/** What a failed tool call said, for the error the model reads: its text blocks joined,
 *  or the content as JSON when it carries no text. */
export function mcpErrorText(content: unknown): string {
  if (Array.isArray(content)) {
    const texts = content
      .filter((b): b is { type: "text"; text: string } =>
        !!b && typeof b === "object" && b.type === "text" && typeof b.text === "string",
      )
      .map((b) => b.text.trim())
      .filter((t) => t.length > 0);
    if (texts.length > 0) return texts.join("\n");
  }
  if (typeof content === "string" && content.trim().length > 0) return content.trim();
  return content === undefined ? "" : JSON.stringify(content);
}

/** MCP content blocks are nearly Ai content parts, but an image block names its MIME
 *  type `mimeType` where the Ai contract uses `mediaType`. Translate the block types
 *  the Ai contract understands (text, image) so a vision MCP tool's image reaches the
 *  model as an image part rather than a JSON-stringified blob. If any block is an
 *  unrecognized kind (resource link, audio, …), hand the whole array back untouched so
 *  no information is dropped — the agent serializes it as before. */
export function normalizeMcpContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  const parts: ContentPart[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") return content;
    const b = block as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      parts.push({ type: "text", text: b.text });
    } else if (b.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string") {
      parts.push({ type: "image", data: b.data, mediaType: b.mimeType });
    } else {
      return content;
    }
  }
  return parts.length > 0 ? parts : content;
}
