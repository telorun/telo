import type { AssistantPart, ToolCallView } from "./types";

/** Extend the last part when it is a segment of the same kind, otherwise open a
 *  new one — so a thought resumed after a tool call is its own segment, in the
 *  place it happened. */
export function appendDelta(parts: AssistantPart[], kind: "thinking" | "text", delta: string): AssistantPart[] {
  if (!delta) return parts;
  const last = parts[parts.length - 1];
  if (last && last.kind === kind) {
    return [...parts.slice(0, -1), { kind, text: last.text + delta }];
  }
  return [...parts, { kind, text: delta }];
}

export function appendToolCall(parts: AssistantPart[], tool: ToolCallView): AssistantPart[] {
  return [...parts, { kind: "tool", tool }];
}

/** Settle the running call a result belongs to, in place: by id, or by name
 *  when the result carries no id. */
export function settleToolCall(
  parts: AssistantPart[],
  result: { toolCallId?: string; name?: string },
  settle: (tool: ToolCallView) => ToolCallView,
): AssistantPart[] {
  return parts.map((part) =>
    part.kind === "tool" &&
    part.tool.state === "running" &&
    (result.toolCallId ? part.tool.toolCallId === result.toolCallId : part.tool.name === result.name)
      ? { kind: "tool", tool: settle(part.tool) }
      : part,
  );
}

export function toolCalls(parts: AssistantPart[]): ToolCallView[] {
  return parts.flatMap((part) => (part.kind === "tool" ? [part.tool] : []));
}
