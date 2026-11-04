import { integerInput } from "@telorun/sdk";

/** The operations an `ai-chat` endpoint supports. */
export const OPERATIONS = ["branch", "cancel"] as const;

export interface OfferedType {
  type: "image" | "audio" | "video" | "file";
  mediaTypes: string[];
  maxBytes: number;
}

/** A `Conversation.Spec` value. */
export interface ConversationSpec {
  attachments?: { accepts: OfferedType[]; maxPerMessage: number };
  operations: string[];
}

interface AcceptedEntry {
  type: OfferedType["type"];
  mediaTypes: string[];
  maxBytes?: unknown;
}

/**
 * The spec over what the agent's model accepts: each entry's bound is the
 * tighter of the model's and the conversation's own, and a model that takes
 * nothing beside text offers no attachments.
 */
export function conversationSpec(
  accepts: readonly AcceptedEntry[],
  bounds: { maxBytes: number; maxPerMessage: number },
): ConversationSpec {
  const operations = [...OPERATIONS];
  if (accepts.length === 0) return { operations };
  return {
    attachments: {
      accepts: accepts.map((entry) => {
        const model = integerInput(entry.maxBytes);
        return {
          type: entry.type,
          mediaTypes: [...entry.mediaTypes],
          maxBytes: model === undefined ? bounds.maxBytes : Math.min(model, bounds.maxBytes),
        };
      }),
      maxPerMessage: bounds.maxPerMessage,
    },
    operations,
  };
}

/** Whether a media type falls within an entry's list — exact, or a whole type
 *  written `image/*`; parameters and case are not part of the type. Held equal
 *  to `Ai.AcceptedContent`'s own rule by a unit test. */
export function mediaTypeMatches(mediaTypes: readonly string[], mediaType: string): boolean {
  const type = (mediaType.split(";")[0] ?? "").trim().toLowerCase();
  return mediaTypes.some(
    (accepted) => accepted === type || (accepted.endsWith("/*") && type.startsWith(accepted.slice(0, -1))),
  );
}

/** The offered entry a media type falls within, if any. */
export function offeredEntry(spec: ConversationSpec, mediaType: string): OfferedType | undefined {
  return spec.attachments?.accepts.find((entry) => mediaTypeMatches(entry.mediaTypes, mediaType));
}

interface ProvidingInstance {
  provide(): Promise<unknown> | unknown;
}

export const isProviding = (candidate: unknown): candidate is ProvidingInstance =>
  typeof (candidate as ProvidingInstance | null)?.provide === "function";
