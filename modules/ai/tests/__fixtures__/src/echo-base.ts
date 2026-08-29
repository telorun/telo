/**
 * What the two echo fixtures share.
 *
 * `Ai.Model` and `Ai.ModelStream` are two abstracts with one entry point each,
 * so the fixture is two controllers — and this is what stops them drifting into
 * echoing differently, which would make a streaming test pass for a reason the
 * buffered one does not.
 */
import { InvokeError } from "@telorun/sdk";
import { contentToText } from "@telorun/ai";
import type { Message, ModelInvokeInput } from "@telorun/ai";

export interface EchoFailRule {
  message: string;
  code: string;
  reason: string;
}

export interface EchoResource {
  metadata: { name: string; module?: string };
  suffix?: string;
  failOn?: EchoFailRule;
  /** Test-only: when `tools` are present and no tool result is in the conversation yet,
   *  emit this tool call instead of echoing — lets agent-loop tests run hermetically. */
  emitToolCall?: { name: string; arguments?: Record<string, unknown> };
  /** Test-only: reject the iteration after this many text deltas, which is how a
   *  mid-stream provider failure actually presents now that a stream fails by
   *  rejecting rather than by yielding an error part. */
  failAfterDeltas?: number;
  /** Test-only: emit this as a `provider-state` part before the deltas. */
  emitProviderState?: string;
}

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

  snapshot(): Record<string, unknown> {
    return { suffix: this.resource.suffix ?? "" };
  }

  protected buildEchoText(messages: Message[]): string {
    const last = messages[messages.length - 1];
    return contentToText(last?.content) + (this.resource.suffix ?? "");
  }

  /** True on the first tool-calling turn — tools offered and nothing answered yet. */
  protected shouldCallTool(input: ModelInvokeInput): boolean {
    const { messages, tools } = input;
    return (
      this.resource.emitToolCall !== undefined &&
      tools !== undefined &&
      tools.length > 0 &&
      !messages.some((m) => m.role === "tool")
    );
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

