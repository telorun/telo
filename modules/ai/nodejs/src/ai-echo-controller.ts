import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";
import { contentToText } from "./content.js";
import type {
  AiModelInstance,
  CompletionResult,
  Message,
  ModelInvokeInput,
  StreamPart,
} from "./types.js";

/**
 * Ai.EchoModel — hermetic test fixture. Echoes the content of the last message,
 * optionally with a suffix, and reports zero token usage. Implements the full
 * `AiModelInstance` contract (both `invoke` and `stream`) so stream-path tests
 * don't require a live provider.
 */
interface EchoFailRule {
  message: string;
  code: string;
  reason: string;
}

interface EchoResource {
  metadata: { name: string; module?: string };
  suffix?: string;
  failOn?: EchoFailRule;
  /** Test-only: when `tools` are present and no tool result is in the conversation yet,
   *  emit this tool call instead of echoing — lets agent-loop tests run hermetically. */
  emitToolCall?: { name: string; arguments?: Record<string, unknown> };
}

class AiEchoModel implements ResourceInstance, AiModelInstance {
  constructor(private readonly resource: EchoResource) {}

  async invoke({ messages, tools }: ModelInvokeInput): Promise<CompletionResult> {
    this.maybeThrow(messages);
    const plan = this.resource.emitToolCall;
    const alreadyCalled = messages.some((m) => m.role === "tool");
    if (plan && tools && tools.length > 0 && !alreadyCalled) {
      return {
        text: "",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: "tool-calls",
        toolCalls: [{ id: "echo-call-1", name: plan.name, arguments: plan.arguments ?? {} }],
      };
    }
    const text = this.buildEchoText(messages);
    return {
      text,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    };
  }

  async *stream({ messages, tools }: ModelInvokeInput): AsyncIterable<StreamPart> {
    this.maybeThrow(messages);
    const plan = this.resource.emitToolCall;
    const alreadyCalled = messages.some((m) => m.role === "tool");
    // First tool-calling turn: emit a tool-call part and finish with `tool-calls`
    // (mirroring invoke()), which is what drives the streaming agent's second turn.
    // A finish left at `stop` would terminate the loop after one turn.
    if (plan && tools && tools.length > 0 && !alreadyCalled) {
      yield {
        type: "tool-call",
        toolCall: { id: "echo-call-1", name: plan.name, arguments: plan.arguments ?? {} },
      };
      yield {
        type: "finish",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: "tool-calls",
      };
      return;
    }
    const text = this.buildEchoText(messages);
    // One text-delta per character — gives streaming consumers multiple chunks to
    // observe. Array.from handles surrogate pairs / combining marks by code point.
    for (const ch of Array.from(text)) {
      yield { type: "text-delta", delta: ch };
    }
    yield {
      type: "finish",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    };
  }

  snapshot(): Record<string, unknown> {
    return { suffix: this.resource.suffix ?? "" };
  }

  private buildEchoText(messages: Message[]): string {
    const last = messages[messages.length - 1];
    return contentToText(last?.content) + (this.resource.suffix ?? "");
  }

  private maybeThrow(messages: Message[]): void {
    const rule = this.resource.failOn;
    if (!rule) return;
    const last = messages[messages.length - 1];
    if (contentToText(last?.content) === rule.message) {
      throw new InvokeError(rule.code, rule.reason);
    }
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(resource: EchoResource, _ctx: ResourceContext): Promise<AiEchoModel> {
  return new AiEchoModel(resource);
}

export const schema = {
  type: "object",
  additionalProperties: true,
};
