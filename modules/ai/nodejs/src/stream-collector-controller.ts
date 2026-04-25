import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";
import type { AiModelInstance, FinishReason, Message, StreamPart } from "./types.js";

/**
 * Test-support Invocable that consumes an `Ai.Model.stream(...)` and collects its output.
 * Exists because the primary consumer of `stream()` — a future `Ai.Stream` kind — isn't
 * part of v1 (see model-and-completion plan §12). Without this, stream-contract tests
 * would need to pass the live instance into a JS.Script, and ordinary JS sandbox inputs
 * don't carry prototype methods from a provider's class-based controller.
 *
 * Given an injected `model: AiModelInstance` (via Phase 5) and inputs `{ prompt | messages }`,
 * consumes every `StreamPart`, and returns:
 *   - `deltas`  — concatenation of all `text-delta` parts
 *   - `deltaCount` — number of `text-delta` parts
 *   - `finishReason` — from the (required) `finish` part
 *   - `usage` — from the `finish` part
 *   - `parts` — the full tagged-part sequence, for tests that want to inspect order
 */
interface StreamCollectorResource {
  metadata: { name: string; module?: string };
  model: AiModelInstance;
}

interface StreamCollectorInputs {
  prompt?: string;
  messages?: Message[];
}

interface StreamCollectorOutput {
  deltas: string;
  deltaCount: number;
  finishReason: FinishReason | null;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
  parts: StreamPart[];
}

class StreamCollector implements ResourceInstance<StreamCollectorInputs, StreamCollectorOutput> {
  constructor(private readonly resource: StreamCollectorResource) {}

  async invoke(inputs: StreamCollectorInputs = {}): Promise<StreamCollectorOutput> {
    const name = this.resource.metadata.name;
    const hasPrompt = typeof inputs.prompt === "string";
    const hasMessages = Array.isArray(inputs.messages);
    if (hasPrompt === hasMessages) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        hasPrompt
          ? `AiEcho.StreamCollector "${name}": exactly one of 'prompt' or 'messages' may be provided, not both.`
          : `AiEcho.StreamCollector "${name}": one of 'prompt' or 'messages' is required.`,
      );
    }
    const messages: Message[] = hasMessages
      ? inputs.messages!
      : [{ role: "user", content: inputs.prompt! }];

    const parts: StreamPart[] = [];
    let deltas = "";
    let deltaCount = 0;
    let finishReason: FinishReason | null = null;
    let usage: StreamCollectorOutput["usage"] = null;
    let finishCount = 0;
    let errorCount = 0;

    // The Ai.Model streaming contract lets providers signal failure by either
    // yielding `{type: "error"}` or throwing from the iterator. Normalize a thrown
    // error into a synthetic `error` part so the rest of this method handles both
    // mechanisms uniformly — same terminator semantics, same contract-violation
    // checks below.
    try {
      for await (const part of this.resource.model.stream({ messages })) {
        parts.push(part);
        if (part.type === "text-delta") {
          deltas += part.delta;
          deltaCount++;
        } else if (part.type === "finish") {
          finishReason = part.finishReason;
          usage = part.usage;
          finishCount++;
        } else if (part.type === "error") {
          errorCount++;
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      parts.push({ type: "error", error });
      errorCount++;
    }

    if (finishCount > 1) {
      throw new InvokeError(
        "ERR_CONTRACT_VIOLATION",
        `AiEcho.StreamCollector "${name}": stream emitted ${finishCount} 'finish' parts; the Ai.Model contract allows at most one.`,
      );
    }
    if (finishCount === 0 && errorCount === 0) {
      throw new InvokeError(
        "ERR_CONTRACT_VIOLATION",
        `AiEcho.StreamCollector "${name}": stream ended without a terminator — expected exactly one 'finish' part, or an 'error' part.`,
      );
    }

    return { deltas, deltaCount, finishReason, usage, parts };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: StreamCollectorResource,
  _ctx: ResourceContext,
): Promise<StreamCollector> {
  return new StreamCollector(resource);
}

export const schema = {
  type: "object",
  additionalProperties: true,
};
