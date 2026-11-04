import { InvokeError } from "@telorun/sdk";
import type { InvokeContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { acceptedByModel } from "./accepted-content.js";
import type {
  AiModelStreamInstance,
  CompletionResult,
  ContentPart,
  FinishReason,
  ModelInvokeInput,
  ToolCall,
  Usage,
} from "./types.js";

interface AiBufferedResource {
  metadata: { name: string; module?: string };
  model: AiModelStreamInstance;
}

const NO_USAGE: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/**
 * Ai.Buffered — a streaming model presented as a buffered one. It drives the
 * stream and folds every part into one answer; what the streaming model throws
 * is what this throws, since the fold catches nothing.
 *
 * Every part type is folded, not just text: dropping `provider-state` would lose
 * the reasoning chain across a tool loop.
 */
class AiBuffered implements ResourceInstance<ModelInvokeInput, CompletionResult> {
  constructor(private readonly resource: AiBufferedResource) {}

  async invoke(input: ModelInvokeInput, ctx?: InvokeContext): Promise<CompletionResult> {
    const model = this.resource.model;
    if (!model || typeof model.invoke !== "function") {
      throw new InvokeError(
        "ERR_INVALID_REFERENCE",
        `Ai.Buffered "${this.resource.metadata.name}": 'model' is not a live Ai.ModelStream instance.`,
      );
    }
    const { output } = await model.invoke(input, ctx);
    const texts: string[] = [];
    const reasoning: string[] = [];
    const contentParts: ContentPart[] = [];
    const toolCalls: ToolCall[] = [];
    let providerState: unknown = null;
    let finish: { usage: Usage; finishReason: FinishReason } | undefined;
    let finishes = 0;
    for await (const part of output) {
      switch (part.type) {
        case "text-delta":
          texts.push(part.delta);
          break;
        case "reasoning-delta":
          reasoning.push(part.delta);
          break;
        case "content-part":
          contentParts.push(part.part);
          break;
        case "tool-call":
          toolCalls.push(part.toolCall);
          break;
        case "provider-state":
          providerState = part.providerState;
          break;
        case "finish":
          finishes++;
          finish = part;
          break;
      }
    }
    const text = texts.join("");
    const content: ContentPart[] = [
      ...(texts.length === 0 ? [] : [{ type: "text", text } as ContentPart]),
      ...(reasoning.length === 0
        ? []
        : [{ type: "reasoning", text: reasoning.join("") } as ContentPart]),
      ...contentParts,
    ];
    // `finish` is the only terminator and exactly one exists by contract; a
    // provider that ends without one is read as an answer that stopped for no stated reason.
    return {
      text,
      content,
      usage: finishes === 1 ? finish!.usage : NO_USAGE,
      finishReason: finishes === 1 ? finish!.finishReason : "other",
      toolCalls,
      providerState,
    };
  }

  snapshot(): Record<string, unknown> {
    return { accepts: acceptedByModel(this.resource.model) };
  }
}

export function register(): void {}

export async function create(
  resource: AiBufferedResource,
  _ctx: ResourceContext,
): Promise<AiBuffered> {
  return new AiBuffered(resource);
}
