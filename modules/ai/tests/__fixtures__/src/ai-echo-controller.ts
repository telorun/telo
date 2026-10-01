import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import type { AiModelInstance, CompletionResult, ModelInvokeInput } from "@telorun/ai";
import { EchoBase, type EchoResource } from "./echo-base.js";

/** The buffered echo — `Ai.Model`. */
class AiEchoModel extends EchoBase implements ResourceInstance, AiModelInstance {
  async invoke(input: ModelInvokeInput): Promise<CompletionResult> {
    this.maybeThrow(input.messages);
    if (this.shouldCallTool(input)) {
      const plan = this.resource.emitToolCall!;
      // A call told to answer without a tool still gets its text here, beside the
      // tool call the fixture returns regardless.
      const text = input.toolChoice === "none" ? this.buildEchoText(input) : "";
      return {
        content: text === "" ? [] : [{ type: "text", text }],
        text,
        usage: this.usage,
        finishReason: "tool-calls",
        toolCalls: [{ id: "echo-call-1", name: plan.name, arguments: plan.arguments ?? {} }],
      };
    }
    const text = this.buildEchoText(input);
    return {
      content: [{ type: "text", text }],
      text,
      usage: this.usage,
      finishReason: "stop",
    };
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(resource: EchoResource, _ctx: ResourceContext): Promise<AiEchoModel> {
  return new AiEchoModel(resource);
}
