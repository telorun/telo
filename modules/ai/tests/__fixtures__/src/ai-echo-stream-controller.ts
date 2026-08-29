import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError, Stream } from "@telorun/sdk";
import type {
  AiModelStreamInstance,
  ModelInvokeInput,
  ModelStreamResult,
  StreamPart,
} from "@telorun/ai";
import { EchoBase, NO_USAGE, type EchoResource } from "./echo-base.js";

/** The streaming echo — `Ai.ModelStream`. */
class AiEchoModelStream extends EchoBase implements ResourceInstance, AiModelStreamInstance {
  async invoke(input: ModelInvokeInput): Promise<ModelStreamResult> {
    // Raised from `invoke` rather than from the stream: a request the provider
    // refuses outright fails the CALL, and only a failure during generation
    // rejects the iteration.
    this.maybeThrow(input.messages);
    return { output: new Stream(this.parts(input)) };
  }

  private async *parts(input: ModelInvokeInput): AsyncIterable<StreamPart> {
    if (this.shouldCallTool(input)) {
      const plan = this.resource.emitToolCall!;
      yield {
        type: "tool-call",
        toolCall: { id: "echo-call-1", name: plan.name, arguments: plan.arguments ?? {} },
      };
      // `tool-calls` rather than `stop` is what drives the agent's second turn.
      yield { type: "finish", usage: NO_USAGE, finishReason: "tool-calls" };
      return;
    }
    // Opaque state, emitted before the deltas the way a provider that keeps its
    // reasoning server-side does. What must survive a fold back to buffered.
    if (this.resource.emitProviderState !== undefined) {
      yield { type: "provider-state", providerState: this.resource.emitProviderState };
    }
    const text = this.buildEchoText(input.messages);
    const failAfter = this.resource.failAfterDeltas;
    let emitted = 0;
    // One delta per code point, so a consumer sees several chunks.
    for (const ch of Array.from(text)) {
      if (failAfter !== undefined && emitted >= failAfter) {
        throw new InvokeError(
          "ERR_PROVIDER_STREAM_FAILED",
          "simulated mid-stream provider failure from echo fixture",
        );
      }
      yield { type: "text-delta", delta: ch };
      emitted++;
    }
    yield { type: "finish", usage: NO_USAGE, finishReason: "stop" };
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: EchoResource,
  _ctx: ResourceContext,
): Promise<AiEchoModelStream> {
  return new AiEchoModelStream(resource);
}
