import type {
  ControllerContext,
  InvokeContext,
  ResourceContext,
  ResourceInstance,
} from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";
import { logCompletion } from "./completion-log.js";
import { isContentParts } from "./content.js";
import { tokenCounts, withTokenQuantity } from "./usage.js";
import type { AiModelInstance, FinishReason, Message, Usage } from "./types.js";

/**
 * Shape of the Ai.Text manifest after Phase 5 ref injection.
 * `model` is replaced in-place with the live `AiModelInstance` returned by the
 * referenced provider's controller.
 */
interface AiTextResource {
  metadata: { name: string; module?: string };
  model: AiModelInstance;
  system?: string;
  options?: Record<string, unknown>;
}

interface AiTextInputs {
  prompt?: string;
  messages?: Message[];
  system?: string;
  options?: Record<string, unknown>;
}

const VALID_ROLES = new Set(["system", "user", "assistant"]);

/** What Ai.Text answers with — narrower than the model's own result, because
 *  this kind is the TEXT operation: the parts, the tool calls and the provider
 *  state are the model's contract, not this one's. */
interface AiTextResult {
  text: string;
  usage: Usage;
  finishReason: FinishReason;
}

class AiText implements ResourceInstance<AiTextInputs, AiTextResult> {
  constructor(
    private readonly resource: AiTextResource,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(inputs: AiTextInputs = {}, ctx?: InvokeContext): Promise<AiTextResult> {
    const name = this.resource.metadata.name;
    const hasPrompt = typeof inputs.prompt === "string";
    const hasMessages = Array.isArray(inputs.messages);

    // Mutual exclusivity — exactly one of prompt/messages.
    if (hasPrompt === hasMessages) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        hasPrompt
          ? `Ai.Text "${name}": exactly one of 'prompt' or 'messages' may be provided, not both.`
          : `Ai.Text "${name}": one of 'prompt' or 'messages' is required.`,
      );
    }

    // Build canonical messages from either form.
    const base: Message[] = hasMessages
      ? validateMessages(inputs.messages!, name)
      : [{ role: "user", content: inputs.prompt! }];

    const systemText = inputs.system ?? this.resource.system;
    let messages: Message[];
    if (systemText !== undefined) {
      if (base[0]?.role === "system") {
        // Runtime / manifest system prompt wins over an inline system message in `messages`.
        messages = [{ role: "system", content: systemText }, ...base.slice(1)];
      } else {
        messages = [{ role: "system", content: systemText }, ...base];
      }
    } else {
      messages = base;
    }

    // Merge options: manifest (resource) → runtime (inputs), shallow, inputs wins.
    // Provider-level defaults and Ai.<Provider>Model.options are merged inside the
    // provider controller; completion sees only its own + runtime layers.
    // Validate `inputs.options` before spreading: a non-object (string, array, …)
    // would either throw mid-spread or produce silently-corrupted keys (e.g.
    // `{...[1,2]}` → `{0:1,1:2}`), and the provider would receive a malformed bag.
    if (inputs.options !== undefined && inputs.options !== null) {
      if (typeof inputs.options !== "object" || Array.isArray(inputs.options)) {
        throw new InvokeError(
          "ERR_INVALID_INPUT",
          `Ai.Text "${name}": 'options' must be an object.`,
        );
      }
    }
    const mergedOptions: Record<string, unknown> = {
      ...(this.resource.options ?? {}),
      ...(inputs.options ?? {}),
    };

    // Delegate to the injected provider instance.
    const model = this.resource.model;
    if (!model || typeof model.invoke !== "function") {
      throw new InvokeError(
        "ERR_INVALID_REFERENCE",
        `Ai.Text "${name}": 'model' is not a live Ai.Model instance — check that Phase 5 injection ran and the referenced resource exists.`,
      );
    }
    // The kernel binds `invoke` and AJV-checks both directions at dispatch, so
    // the result arrives already held to `Ai.Model`'s declared outputType —
    // which is why the hand-rolled result validation that used to stand here is
    // gone rather than merely moved. Cancellation rides the InvokeContext.
    const result = await model.invoke({ messages, options: mergedOptions }, ctx);

    // Stamp the provider-neutral half of usage here rather than asking every
    // provider for it — the token triple already carries the answer, and doing it
    // in the operation keeps existing providers unchanged.
    const usage = withTokenQuantity(tokenCounts(result.usage));
    logCompletion(this.ctx.log, "Completion finished", usage, result.finishReason);
    // This kind's own contract is narrower than the model's: it answers with
    // text, so the parts, the tool calls and the provider state stop here.
    return { text: result.text, usage, finishReason: result.finishReason };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

function validateMessages(messages: Message[], resourceName: string): Message[] {
  if (messages.length === 0) {
    throw new InvokeError(
      "ERR_INVALID_INPUT",
      `Ai.Text "${resourceName}": 'messages' must contain at least one message.`,
    );
  }
  for (const [i, m] of messages.entries()) {
    if (!m || typeof m !== "object") {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Ai.Text "${resourceName}": messages[${i}] is not an object.`,
      );
    }
    if (typeof m.role !== "string" || !VALID_ROLES.has(m.role)) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Ai.Text "${resourceName}": messages[${i}].role must be 'system' | 'user' | 'assistant'.`,
      );
    }
    if (typeof m.content !== "string" && !isContentParts(m.content)) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Ai.Text "${resourceName}": messages[${i}].content must be a string or a non-empty array of content parts.`,
      );
    }
  }
  return messages;
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: AiTextResource,
  ctx: ResourceContext,
): Promise<AiText> {
  return new AiText(resource, ctx);
}

