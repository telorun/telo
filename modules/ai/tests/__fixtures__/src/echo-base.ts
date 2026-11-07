/**
 * What the two echo fixtures share.
 *
 * `Ai.Model` and `Ai.ModelStream` are two abstracts with one entry point each,
 * so the fixture is two controllers — and this is what stops them drifting into
 * echoing differently, which would make a streaming test pass for a reason the
 * buffered one does not.
 */
import { InvokeError } from "@telorun/sdk";
import { contentToText, isMediaPart } from "@telorun/ai";
import type {
  AcceptedContent,
  Message,
  MessageContent,
  ModelInvokeInput,
  ToolCall,
} from "@telorun/ai";

export interface EchoFailRule {
  message: string;
  code: string;
  reason: string;
}

export interface EchoReply {
  text: string;
  toolCalls?: Array<{ id: string; name: string; arguments?: Record<string, unknown> }>;
  finishReason?: "stop" | "length" | "tool-calls";
}

export interface EchoResource {
  metadata: { name: string; module?: string };
  /** What the fixture publishes as accepted; every type when unset, since it echoes any part. */
  accepts?: AcceptedContent;
  suffix?: string;
  failOn?: EchoFailRule;
  /** Test-only: when `tools` are present and no tool result is in the conversation yet,
   *  emit this tool call instead of echoing — lets agent-loop tests run hermetically. */
  emitToolCall?: { name: string; arguments?: Record<string, unknown> };
  /** Test-only: the same, as several calls in one response, each with its own id. */
  emitToolCalls?: Array<{ id: string; name: string; arguments?: Record<string, unknown> }>;
  /** Test-only: answer with the request's messages instead of the last one's
   *  text — `role[toolCallId]=text` each, joined by ` | ` — so a test sees the
   *  conversation a call was given, in the order it was given. */
  echoConversation?: boolean;
  /** Test-only: echo a media part where it stands, as `<type>(<uri>)` — or
   *  `<type>(<n> bytes)` for one carrying its bytes — so a test sees which
   *  references reached the model as written. */
  echoMedia?: boolean;
  /** Test-only: emit `emitToolCall` on every call that offers tools, whatever the
   *  conversation or `toolChoice` — a model that never converges, and that
   *  disobeys a call that may not use a tool. */
  toolCallEveryTurn?: boolean;
  /** Test-only: precede the tool call with its argument JSON as two
   *  `tool-call-delta` parts. Streaming fixture only. */
  emitToolCallDeltas?: boolean;
  /** Test-only: echo the request's shape after the last message's text —
   *  ` [tools: a,b] [toolChoice: none]` — so a test sees what a call was given. */
  echoRequest?: boolean;
  /** Test-only: reject the iteration after this many text deltas, which is how a
   *  mid-stream provider failure actually presents now that a stream fails by
   *  rejecting rather than by yielding an error part. */
  failAfterDeltas?: number;
  /** Test-only: emit this as a `provider-state` part before the deltas. */
  emitProviderState?: string;
  /** Test-only: emit `{ received }` as a `provider-state` part at the start of every
   *  call, `received` being the `providerState` that call was given (null when
   *  none) — so a test sees what reached each call and what is replayed. */
  echoProviderState?: boolean;
  /** Test-only: the reply the call whose request holds n assistant messages
   *  answers with; a call past the list echoes. */
  replies?: EchoReply[];
  /** Test-only: the token usage every call reports. Zero when unset. */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedPromptTokens?: number;
    cacheWritePromptTokens?: number;
    reasoningTokens?: number;
  };
}

const ACCEPTS_EVERYTHING: AcceptedContent = [
  { type: "image", mediaTypes: ["image/*"] },
  { type: "audio", mediaTypes: ["audio/*"] },
  { type: "video", mediaTypes: ["video/*"] },
  { type: "file", mediaTypes: ["application/*", "text/*"] },
];

export const NO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  unit: "tokens",
  total: 0,
};

/** Shared behaviour, so the two contracts cannot drift into echoing differently. */
export abstract class EchoBase {
  constructor(protected readonly resource: EchoResource) {}

  protected get usage() {
    const usage = this.resource.usage;
    return usage ? { ...usage, unit: "tokens", total: usage.totalTokens } : NO_USAGE;
  }

  snapshot(): Record<string, unknown> {
    return { suffix: this.resource.suffix ?? "", accepts: this.resource.accepts ?? ACCEPTS_EVERYTHING };
  }

  /** A message's text, with its media parts where they stand under `echoMedia`. */
  private echoed(content: MessageContent | undefined): string {
    if (!this.resource.echoMedia || content === undefined || typeof content === "string") {
      return contentToText(content);
    }
    return content
      .map((part) => {
        if (!isMediaPart(part)) return contentToText([part]);
        const data = part.data;
        const size = typeof data === "string" ? data.length : data?.byteLength;
        return `${part.type}(${part.uri ?? `${size} bytes`})`;
      })
      .join("");
  }

  protected buildEchoText(input: ModelInvokeInput): string {
    if (this.resource.echoConversation) {
      return input.messages
        .map((m) => `${m.role}${m.toolCallId ? `[${m.toolCallId}]` : ""}=${this.echoed(m.content)}`)
        .join(" | ");
    }
    const last = input.messages[input.messages.length - 1];
    const text = this.echoed(last?.content) + (this.resource.suffix ?? "");
    if (!this.resource.echoRequest) return text;
    const tools = (input.tools ?? []).map((tool) => tool.name).join(",");
    return `${text} [tools: ${tools}] [toolChoice: ${input.toolChoice ?? "absent"}]`;
  }

  /** True on the first tool-calling turn — tools offered and nothing answered yet —
   *  and on every turn offering tools under `toolCallEveryTurn`. */
  protected shouldCallTool(input: ModelInvokeInput): boolean {
    const { messages, tools } = input;
    return (
      this.plannedToolCalls().length > 0 &&
      tools !== undefined &&
      tools.length > 0 &&
      (this.resource.toolCallEveryTurn === true || !messages.some((m) => m.role === "tool"))
    );
  }

  /** The calls a tool-calling turn asks for: `emitToolCalls`, else the one
   *  `emitToolCall` under the fixture's fixed id. */
  protected plannedToolCalls(): ToolCall[] {
    const { emitToolCall, emitToolCalls } = this.resource;
    const planned = emitToolCalls ?? (emitToolCall ? [{ id: "echo-call-1", ...emitToolCall }] : []);
    return planned.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments ?? {} }));
  }

  /** The scripted reply this call answers with, if the conversation is not past
   *  the script: entry n for a request holding n assistant messages. */
  protected scriptedReply(
    input: ModelInvokeInput,
  ): { text: string; toolCalls: ToolCall[]; finishReason: NonNullable<EchoReply["finishReason"]> } | undefined {
    const index = input.messages.filter((m) => m.role === "assistant").length;
    const reply = this.resource.replies?.[index];
    if (!reply) return undefined;
    const toolCalls: ToolCall[] = (reply.toolCalls ?? []).map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.arguments ?? {},
    }));
    return {
      text: reply.text,
      toolCalls,
      finishReason: reply.finishReason ?? (toolCalls.length > 0 ? "tool-calls" : "stop"),
    };
  }

  protected maybeThrow(messages: Message[]): void {
    const rule = this.resource.failOn;
    if (!rule) return;
    const last = messages[messages.length - 1];
    if (contentToText(last?.content) === rule.message) {
      throw new InvokeError(rule.code, rule.reason);
    }
  }
}

