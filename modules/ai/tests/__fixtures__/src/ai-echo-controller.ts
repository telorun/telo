import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import type { AiModelInstance, CompletionResult, ModelInvokeInput } from "@telorun/ai";
import { EchoBase, NO_USAGE, type EchoResource } from "./echo-base.js";

/** The buffered echo — `Ai.Model`. */
class AiEchoModel extends EchoBase implements ResourceInstance, AiModelInstance {
  async invoke(input: ModelInvokeInput): Promise<CompletionResult> {
    this.maybeThrow(input.messages);
    if (this.shouldCallTool(input)) {
      const plan = this.resource.emitToolCall!;
      return {
        content: [],
        text: "",
        usage: NO_USAGE,
        finishReason: "tool-calls",
        toolCalls: [{ id: "echo-call-1", name: plan.name, arguments: plan.arguments ?? {} }],
      };
    }
    const text = this.buildEchoText(input.messages);
    return {
      content: [{ type: "text", text }],
      text,
      usage: NO_USAGE,
      finishReason: "stop",
    };
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(resource: EchoResource, _ctx: ResourceContext): Promise<AiEchoModel> {
  return new AiEchoModel(resource);
}
