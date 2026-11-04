import { integerInput } from "@telorun/sdk";

/**
 * How each `Ai.AgentStreamPart` type reaches a client: the `Conversation.Event`
 * type it becomes, or nothing. A unit test reads both manifests and fails when
 * a part type is in neither table.
 */
export const PART_EVENTS = {
  "text-delta": "text-delta",
  "reasoning-delta": "reasoning-delta",
  "content-part": "content",
  "tool-call-delta": "tool-call-delta",
  "tool-call": "tool-call",
  "tool-result": "tool-result",
  "step-finish": "step-usage",
  "tool-approval-request": "approval-request",
  "tool-approval-decision": "approval-decision",
  finish: "turn-end",
} as const;

/** Parts that never cross the wire: `message` is appended to the store, and
 *  provider state is the model's own. */
export const DROPPED_PARTS = ["message", "provider-state"] as const;

/** An agent's token usage as a `Conversation.Usage`. */
export function wireUsage(usage: Record<string, unknown> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  const put = (key: string, value: unknown) => {
    const n = integerInput(value);
    if (n !== undefined) out[key] = n;
  };
  put("inputTokens", usage?.promptTokens);
  put("outputTokens", usage?.completionTokens);
  put("totalTokens", usage?.totalTokens);
  put("reasoningTokens", usage?.reasoningTokens);
  put("cachedInputTokens", usage?.cachedPromptTokens);
  return out;
}

/** Why a turn ended, from the agent's terminal `finish`. A reason the contract
 *  does not name (`other`) ends the turn as stopped. */
export function turnEndReason(finish: { finishReason?: string; limit?: string; interrupt?: string }): string {
  if (finish.interrupt === "approval") return "approval";
  if (finish.limit === "max-steps") return "limit";
  if (finish.finishReason === "length" || finish.finishReason === "content-filter") return finish.finishReason;
  return "stop";
}

/** The event of a part that carries everything it needs, or undefined for one
 *  the run translates with the store (`content-part`, `tool-result`, approvals). */
export function plainEvent(part: Record<string, any>): Record<string, unknown> | undefined {
  switch (part.type) {
    case "text-delta":
      return { type: "text-delta", text: part.delta };
    case "reasoning-delta":
      return { type: "reasoning-delta", text: part.delta };
    case "tool-call-delta":
      return {
        type: "tool-call-delta",
        id: part.toolCallId,
        ...(part.toolName ? { name: part.toolName } : {}),
        argumentsDelta: part.delta,
      };
    case "tool-call":
      return {
        type: "tool-call",
        id: part.toolCall.id,
        name: part.toolCall.name,
        arguments: part.toolCall.arguments ?? {},
      };
    case "step-finish":
      return { type: "step-usage", usage: wireUsage(part.usage) };
    case "finish":
      return { type: "turn-end", reason: turnEndReason(part), usage: wireUsage(part.usage) };
    default:
      return undefined;
  }
}
