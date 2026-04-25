import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";
import type {
  AiModelInstance,
  CompletionResult,
  FinishReason,
  Message,
} from "./types.js";

/**
 * Shape of the Ai.Completion manifest after Phase 5 ref injection.
 * `model` is replaced in-place with the live `AiModelInstance` returned by the
 * referenced provider's controller.
 */
interface AiCompletionResource {
  metadata: { name: string; module?: string };
  model: AiModelInstance;
  system?: string;
  options?: Record<string, unknown>;
}

interface CompletionInputs {
  prompt?: string;
  messages?: Message[];
  system?: string;
  options?: Record<string, unknown>;
}

const VALID_ROLES = new Set(["system", "user", "assistant"]);
const VALID_FINISH_REASONS = new Set(["stop", "length", "content-filter", "error", "other"]);

class AiCompletion implements ResourceInstance<CompletionInputs, CompletionResult> {
  constructor(private readonly resource: AiCompletionResource) {}

  async invoke(inputs: CompletionInputs = {}): Promise<CompletionResult> {
    const name = this.resource.metadata.name;
    const hasPrompt = typeof inputs.prompt === "string";
    const hasMessages = Array.isArray(inputs.messages);

    // Mutual exclusivity — exactly one of prompt/messages.
    if (hasPrompt === hasMessages) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        hasPrompt
          ? `Ai.Completion "${name}": exactly one of 'prompt' or 'messages' may be provided, not both.`
          : `Ai.Completion "${name}": one of 'prompt' or 'messages' is required.`,
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
          `Ai.Completion "${name}": 'options' must be an object.`,
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
        `Ai.Completion "${name}": 'model' is not a live Ai.Model instance — check that Phase 5 injection ran and the referenced resource exists.`,
      );
    }
    const result = await model.invoke({ messages, options: mergedOptions });

    validateCompletionResult(result, name);
    return result;
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

function validateMessages(messages: Message[], completionName: string): Message[] {
  if (messages.length === 0) {
    throw new InvokeError(
      "ERR_INVALID_INPUT",
      `Ai.Completion "${completionName}": 'messages' must contain at least one message.`,
    );
  }
  for (const [i, m] of messages.entries()) {
    if (!m || typeof m !== "object") {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Ai.Completion "${completionName}": messages[${i}] is not an object.`,
      );
    }
    if (typeof m.role !== "string" || !VALID_ROLES.has(m.role)) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Ai.Completion "${completionName}": messages[${i}].role must be 'system' | 'user' | 'assistant'.`,
      );
    }
    if (typeof m.content !== "string") {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Ai.Completion "${completionName}": messages[${i}].content must be a string.`,
      );
    }
  }
  return messages;
}

function validateCompletionResult(result: unknown, completionName: string): asserts result is CompletionResult {
  const bad = (detail: string): never => {
    throw new InvokeError(
      "ERR_CONTRACT_VIOLATION",
      `Ai.Completion "${completionName}": model returned a value that does not match the Ai.Model output contract — ${detail}.`,
    );
  };
  if (!result || typeof result !== "object") return bad("expected an object");
  const r = result as Record<string, unknown>;
  if (typeof r.text !== "string") return bad("missing string 'text'");
  const usage = r.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return bad("missing 'usage' object");
  for (const key of ["promptTokens", "completionTokens", "totalTokens"] as const) {
    const v = usage[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      return bad(`'usage.${key}' must be a non-negative integer`);
    }
  }
  if (typeof r.finishReason !== "string" || !VALID_FINISH_REASONS.has(r.finishReason as string)) {
    return bad(`'finishReason' must be one of: ${[...VALID_FINISH_REASONS].join(", ")}`);
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: AiCompletionResource,
  _ctx: ResourceContext,
): Promise<AiCompletion> {
  return new AiCompletion(resource);
}

export const schema = {
  type: "object",
  additionalProperties: true,
};
