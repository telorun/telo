import { formatTimestamp, integerInput, isCelTimestamp } from "@telorun/sdk";
import { ATTACHMENT_SCHEME, attachmentUrl } from "./chat-ids.js";

/** A `Conversation.Part`. */
export type WirePart =
  | { type: "text" | "reasoning" | "refusal"; text: string }
  | { type: "image" | "audio" | "video" | "file"; url: string; mediaType: string; name?: string; size?: number }
  | { type: "citation"; url: string; title?: string; quote?: string };

const MEDIA = new Set(["image", "audio", "video", "file"]);

/** A media url as a client reads it: an attachment as its relative reference
 *  under the conversation holding it, any other url as written. */
export function wireUrl(uri: string, conversation: string): string {
  return uri.startsWith(ATTACHMENT_SCHEME) ? attachmentUrl(conversation, uri.slice(ATTACHMENT_SCHEME.length)) : uri;
}

/** An `Ai.ContentPart` as a `Conversation.Part`; a part that carries nothing a
 *  viewer draws (a tool call, which an entry carries as `toolCalls`) is none. */
export function wirePart(part: Record<string, any>, conversation: string): WirePart | undefined {
  switch (part.type) {
    case "text":
    case "reasoning":
    case "refusal":
      return { type: part.type, text: String(part.text ?? "") };
    case "citation": {
      const citation = (part.citation ?? {}) as Record<string, unknown>;
      const url = citation.url ?? citation.uri;
      if (typeof url !== "string" || url.length === 0) return undefined;
      return {
        type: "citation",
        url,
        ...(typeof citation.title === "string" ? { title: citation.title } : {}),
        ...(typeof citation.quote === "string"
          ? { quote: citation.quote }
          : typeof citation.citedText === "string"
            ? { quote: citation.citedText }
            : {}),
      };
    }
    default:
      if (MEDIA.has(part.type) && typeof part.uri === "string") {
        return {
          type: part.type,
          url: wireUrl(part.uri, conversation),
          mediaType: String(part.mediaType ?? "application/octet-stream"),
          ...(typeof part.name === "string" ? { name: part.name } : {}),
        };
      }
      return undefined;
  }
}

/** A tool's result as a client reads it: a media part it carries by
 *  attachment becomes a `Conversation.Part` with the relative reference. */
export function wireToolResult(result: unknown, conversation: string): unknown {
  if (!Array.isArray(result)) return result;
  return result.map((item) => {
    const part = item as Record<string, any> | null;
    const internal = MEDIA.has(part?.type) && typeof part?.uri === "string" && part.uri.startsWith(ATTACHMENT_SCHEME);
    return internal ? (wirePart(part!, conversation) ?? item) : item;
  });
}

/** The parts of a message's content: a string is one text part. */
export function wireParts(content: unknown, conversation: string): WirePart[] {
  if (typeof content === "string") return content.length === 0 ? [] : [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const mapped = wirePart(part as Record<string, any>, conversation);
    return mapped ? [mapped] : [];
  });
}

/** The text a timestamp is written as on the wire. */
export function wireInstant(value: unknown): string {
  if (isCelTimestamp(value)) return formatTimestamp(value);
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

interface Approval {
  id: string;
  toolCallId: string;
  decision: { approved: boolean; reason?: string } | null;
}

/** A stored entry row of `conversation` as a `Conversation.Entry`. A tool
 *  message is an assistant entry carrying its result, since a viewer draws it
 *  with the call. */
export function wireEntry(row: Record<string, any>, conversation: string): Record<string, unknown> {
  const message = row.message as Record<string, any>;
  const siblings = row.siblings as Record<string, unknown>;
  const approvals = (row.approvals ?? []) as Approval[];
  const entry: Record<string, unknown> = {
    id: row.id,
    parent: row.parent ?? null,
    turn: row.turn,
    siblings: {
      position: integerInput(siblings.position),
      count: integerInput(siblings.count),
      previous: siblings.previous ?? null,
      next: siblings.next ?? null,
    },
    role: message.role === "user" ? "user" : "assistant",
    parts: message.role === "tool" ? [] : wireParts(message.content, conversation),
    createdAt: wireInstant(row.createdAt),
  };
  if (message.role === "tool") {
    entry.toolResults = [{ id: message.toolCallId, result: wireToolResult(message.content, conversation) }];
  }
  if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
    entry.toolCalls = message.toolCalls.map((call: Record<string, any>) => {
      const approval = approvals.find((a) => a.toolCallId === call.id);
      return {
        id: call.id,
        name: call.name,
        arguments: call.arguments ?? {},
        ...(approval
          ? {
              approval: {
                id: approval.id,
                decision: approval.decision
                  ? {
                      approved: approval.decision.approved,
                      ...(approval.decision.reason === undefined ? {} : { reason: approval.decision.reason }),
                    }
                  : null,
              },
            }
          : {}),
      };
    });
  }
  return entry;
}

/** A header as a `Conversation.ConversationSummary`, `running` judged by the
 *  caller from the journal. */
export function wireSummary(header: Record<string, any>, running: boolean): Record<string, unknown> {
  return {
    id: header.id,
    title: header.title ?? null,
    archived: header.archived === true,
    updatedAt: wireInstant(header.updatedAt),
    turn: header.turn ?? null,
    running,
  };
}
