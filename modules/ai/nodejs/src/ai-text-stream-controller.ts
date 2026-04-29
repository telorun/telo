import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError, Stream } from "@telorun/sdk";
import type { AiModelInstance, Message, StreamPart } from "./types.js";

/**
 * Shape of the Ai.TextStream manifest after Phase 5 ref injection.
 * `model` is replaced in-place with the live `AiModelInstance` returned by the
 * referenced provider's controller.
 */
interface AiTextStreamResource {
  metadata: { name: string; module?: string };
  model: AiModelInstance;
  system?: string;
  options?: Record<string, unknown>;
}

interface AiTextStreamInputs {
  prompt?: string;
  messages?: Message[];
  system?: string;
  options?: Record<string, unknown>;
}

interface AiTextStreamOutput {
  output: Stream<StreamPart>;
}

const VALID_ROLES = new Set(["system", "user", "assistant"]);

/**
 * Ai.TextStream is a configured wrapper over `Ai.Model.stream()`. It validates
 * inputs, prepends a system prompt, merges options, and forwards the model's
 * StreamPart iterable as `{output: Stream<...>}` per the streaming-Invocable
 * convention. Encoding / wire framing is the consumer's responsibility — pipe
 * through `Encode.Ndjson` / `Encode.Sse` / `Encode.Plain` (or any other Encoder)
 * to turn StreamPart records into bytes, or iterate `result.output` directly in
 * a `JS.Script` step.
 */
class AiTextStream implements ResourceInstance<AiTextStreamInputs, AiTextStreamOutput> {
  constructor(private readonly resource: AiTextStreamResource) {}

  async invoke(inputs: AiTextStreamInputs = {}): Promise<AiTextStreamOutput> {
    const name = this.resource.metadata.name;
    const hasPrompt = typeof inputs.prompt === "string";
    const hasMessages = Array.isArray(inputs.messages);

    if (hasPrompt === hasMessages) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        hasPrompt
          ? `Ai.TextStream "${name}": exactly one of 'prompt' or 'messages' may be provided, not both.`
          : `Ai.TextStream "${name}": one of 'prompt' or 'messages' is required.`,
      );
    }

    const base: Message[] = hasMessages
      ? validateMessages(inputs.messages!, name)
      : [{ role: "user", content: inputs.prompt! }];

    const systemText = inputs.system ?? this.resource.system;
    let messages: Message[];
    if (systemText !== undefined) {
      messages =
        base[0]?.role === "system"
          ? [{ role: "system", content: systemText }, ...base.slice(1)]
          : [{ role: "system", content: systemText }, ...base];
    } else {
      messages = base;
    }

    if (inputs.options !== undefined && inputs.options !== null) {
      if (typeof inputs.options !== "object" || Array.isArray(inputs.options)) {
        throw new InvokeError(
          "ERR_INVALID_INPUT",
          `Ai.TextStream "${name}": 'options' must be an object.`,
        );
      }
    }
    const mergedOptions: Record<string, unknown> = {
      ...(this.resource.options ?? {}),
      ...(inputs.options ?? {}),
    };

    const model = this.resource.model;
    if (!model || typeof model.stream !== "function") {
      throw new InvokeError(
        "ERR_INVALID_REFERENCE",
        `Ai.TextStream "${name}": 'model' is not a live Ai.Model instance with a stream() method — check that Phase 5 injection ran and the referenced resource exists.`,
      );
    }

    const parts = model.stream({ messages, options: mergedOptions });
    return { output: new Stream(parts) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

function validateMessages(messages: Message[], resourceName: string): Message[] {
  if (messages.length === 0) {
    throw new InvokeError(
      "ERR_INVALID_INPUT",
      `Ai.TextStream "${resourceName}": 'messages' must contain at least one message.`,
    );
  }
  for (const [i, m] of messages.entries()) {
    if (!m || typeof m !== "object") {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Ai.TextStream "${resourceName}": messages[${i}] is not an object.`,
      );
    }
    if (typeof m.role !== "string" || !VALID_ROLES.has(m.role)) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Ai.TextStream "${resourceName}": messages[${i}].role must be 'system' | 'user' | 'assistant'.`,
      );
    }
    if (typeof m.content !== "string") {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Ai.TextStream "${resourceName}": messages[${i}].content must be a string.`,
      );
    }
  }
  return messages;
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: AiTextStreamResource,
  _ctx: ResourceContext,
): Promise<AiTextStream> {
  return new AiTextStream(resource);
}

export const schema = {
  type: "object",
  additionalProperties: true,
};
