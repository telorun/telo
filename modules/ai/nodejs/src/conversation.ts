import { InvokeError } from "@telorun/sdk";
import type { AgentStreamPart, Message, ToolApproval, ToolCall } from "./types.js";

/**
 * The conversation of one agent run, as a record: the messages the run was
 * given, then every message it appends, in the order it appends them. Shared by
 * `Ai.Agent` and `Ai.AgentStream`, so what one returns as `messages` is what the
 * other emits as `message` parts.
 *
 * The record is append-only, so a tool's message lands when that tool finishes.
 * A model is always shown each assistant turn's tool messages in that turn's
 * call order — see {@link Conversation.forModel}.
 */
export class Conversation {
  /** What this run appended, in order. */
  readonly appended: Message[] = [];

  private readonly messages: Message[];

  constructor(initial: readonly Message[]) {
    this.messages = [...initial];
  }

  /** Append a message, returning the part that reports it. */
  append(message: Message): Extract<AgentStreamPart, { type: "message" }> {
    this.messages.push(message);
    this.appended.push(message);
    return { type: "message", message };
  }

  /** The conversation as a model request carries it. */
  forModel(): Message[] {
    return inCallOrder(this.messages);
  }

  /** The calls the conversation leaves unanswered, in call order. */
  pendingCalls(): ToolCall[] {
    return pendingCalls(this.messages);
  }
}

/**
 * `messages` with the tool messages following each assistant turn put into that
 * turn's call order. A message answering no call of the turn keeps its place
 * after the ones that do.
 */
export function inCallOrder(messages: readonly Message[]): Message[] {
  const ordered: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    ordered.push(message);
    const calls = message.role === "assistant" ? message.toolCalls : undefined;
    if (!calls || calls.length === 0) continue;
    const results: Message[] = [];
    while (messages[i + 1]?.role === "tool") results.push(messages[++i]!);
    const position = (result: Message) => {
      const index = calls.findIndex((call) => call.id === result.toolCallId);
      return index === -1 ? calls.length : index;
    };
    // `sort` is stable, so equal positions keep the order they were appended in.
    ordered.push(...results.sort((a, b) => position(a) - position(b)));
  }
  return ordered;
}

/**
 * The calls a conversation leaves pending: when it ends with an assistant turn
 * carrying tool calls, followed only by tool messages, those of the turn's calls
 * no tool message answers. None when every call is answered.
 */
export function pendingCalls(messages: readonly Message[]): ToolCall[] {
  let turn = messages.length - 1;
  while (turn >= 0 && messages[turn]!.role === "tool") turn--;
  const assistant = messages[turn];
  if (assistant?.role !== "assistant" || !assistant.toolCalls?.length) return [];
  const answered = new Set(messages.slice(turn + 1).map((message) => message.toolCallId));
  return assistant.toolCalls.filter((call) => !answered.has(call.id));
}

/** What a run settles before it calls the model. */
export interface PendingWork {
  /** The pending calls, in call order. Empty when nothing is pending. */
  calls: ToolCall[];
  /** The caller's decisions, by call id. */
  approvals: Map<string, ToolApproval>;
}

/**
 * The pending calls of the conversation a run was given, with the caller's
 * decisions on them. Everything refused here is decidable from the input alone:
 * decisions beside a `prompt`, a decision for a call that is not pending, two
 * decisions for one call, and two pending calls sharing an id.
 */
export function pendingWork(
  conversation: Conversation,
  inputs: { prompt?: string; approvals?: ToolApproval[] },
  label: string,
): PendingWork {
  const refuse = (message: string) => new InvokeError("ERR_INVALID_INPUT", `${label}: ${message}`);
  const decisions = inputs.approvals ?? [];
  if (decisions.length > 0 && typeof inputs.prompt === "string") {
    throw refuse(
      "'approvals' decides the tool calls a conversation left pending, so it goes with 'messages', never with 'prompt'.",
    );
  }
  const calls = conversation.pendingCalls();
  const ids = new Set<string>();
  for (const call of calls) {
    if (ids.has(call.id)) {
      throw refuse(
        `two pending tool calls share the id "${call.id}", so a decision or a result could not be matched to one of them.`,
      );
    }
    ids.add(call.id);
  }
  const approvals = new Map<string, ToolApproval>();
  for (const decision of decisions) {
    if (approvals.has(decision.toolCallId)) {
      throw refuse(`'approvals' holds two decisions for the tool call "${decision.toolCallId}".`);
    }
    if (!ids.has(decision.toolCallId)) {
      throw refuse(
        `'approvals' names the tool call "${decision.toolCallId}", which is not pending. Pending: ${[...ids].join(", ") || "none"}.`,
      );
    }
    approvals.set(decision.toolCallId, decision);
  }
  return { calls, approvals };
}
