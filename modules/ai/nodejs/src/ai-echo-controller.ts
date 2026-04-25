import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";
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
}

class AiEchoModel implements ResourceInstance, AiModelInstance {
  constructor(private readonly resource: EchoResource) {}

  async invoke({ messages }: ModelInvokeInput): Promise<CompletionResult> {
    this.maybeThrow(messages);
    const text = this.buildEchoText(messages);
    return {
      text,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    };
  }

  async *stream({ messages }: ModelInvokeInput): AsyncIterable<StreamPart> {
    this.maybeThrow(messages);
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
    const content = typeof last?.content === "string" ? last.content : "";
    return content + (this.resource.suffix ?? "");
  }

  private maybeThrow(messages: Message[]): void {
    const rule = this.resource.failOn;
    if (!rule) return;
    const last = messages[messages.length - 1];
    if (typeof last?.content === "string" && last.content === rule.message) {
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
