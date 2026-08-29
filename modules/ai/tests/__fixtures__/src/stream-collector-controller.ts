import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";
import type { AiModelStreamInstance, FinishReason, Message, StreamPart } from "@telorun/ai";

/**
 * Test-support Invocable that consumes an `Ai.Model.stream(...)` and collects its output.
 * Exists because the primary consumer of `stream()` — a future `Ai.Stream` kind — isn't
 * part of v1 (see model-and-completion plan §12). Without this, stream-contract tests
 * would need to pass the live instance into a JS.Script, and ordinary JS sandbox inputs
 * don't carry prototype methods from a provider's class-based controller.
 *
 * Given an injected `model: AiModelStreamInstance` (via Phase 5) and inputs `{ prompt | messages }`,
 * consumes every `StreamPart`, and returns:
 *   - `deltas`  — concatenation of all `text-delta` parts
 *   - `deltaCount` — number of `text-delta` parts
 *   - `finishReason` — from the (required) `finish` part
 *   - `usage` — from the `finish` part
 *   - `parts` — the full tagged-part sequence, for tests that want to inspect order
 */
interface StreamCollectorResource {
  metadata: { name: string; module?: string };
  model: AiModelStreamInstance;
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

    // A failure PROPAGATES. The contract has exactly one way to fail — the
    // iteration rejects — so there is no second mechanism to normalize, and
    // catching here would re-create the swallow the single mechanism removed:
    // a collector that turned a rejection into a data part would report a
    // truncated stream as a complete one.
    const { output } = await this.resource.model.invoke({ messages });
    for await (const part of output) {
      parts.push(part);
      if (part.type === "text-delta") {
        deltas += part.delta;
        deltaCount++;
      } else if (part.type === "finish") {
        finishReason = part.finishReason;
        usage = part.usage;
        finishCount++;
      }
    }

    if (finishCount !== 1) {
      throw new InvokeError(
        "ERR_CONTRACT_VIOLATION",
        `AiEcho.StreamCollector "${name}": stream emitted ${finishCount} 'finish' parts; ` +
          `the Ai.ModelStream contract requires exactly one, since a failure rejects instead.`,
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

