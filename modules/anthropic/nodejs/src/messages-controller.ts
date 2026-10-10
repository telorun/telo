import type { AiModelInstance, CompletionResult, ModelInvokeInput } from "@telorun/ai";
import type {
  ControllerContext,
  InvokeContext,
  ResourceContext,
  ResourceInstance,
} from "@telorun/sdk";
import { building, callLabel, callMessages, reading } from "./anthropic-endpoint.js";
import { buildBody, publishedConfig, type MessagesResource } from "./messages-request.js";
import { readAnswer } from "./messages-response.js";

/**
 * Anthropic's Messages API, for the `Ai.Model` abstract: one request, one
 * complete answer.
 *
 * The request is built before anything is sent, so every refusal the request
 * alone decides — a content part the API cannot carry, a response format, a
 * structural option — is raised by the call with nothing on the wire.
 */
class MessagesModelInstance implements ResourceInstance, AiModelInstance {
  constructor(private readonly resource: MessagesResource) {}

  snapshot(): Record<string, unknown> {
    return publishedConfig(this.resource);
  }

  async invoke(input: ModelInvokeInput, ctx?: InvokeContext): Promise<CompletionResult> {
    const label = callLabel("Anthropic messages", this.resource.metadata.name);
    const body = building(label, ctx, () => buildBody(this.resource, input, label));
    const data = await callMessages(
      this.resource.request,
      label,
      { body, betas: this.resource.betas },
      ctx,
    );
    return reading(label, ctx, () => readAnswer(data, this.resource, label));
  }
}

export function register(ctx: ControllerContext): void {}

export async function create(
  resource: MessagesResource,
  ctx: ResourceContext,
): Promise<MessagesModelInstance> {
  return new MessagesModelInstance(resource);
}
