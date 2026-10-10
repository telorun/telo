import type {
  AiModelStreamInstance,
  ModelInvokeInput,
  ModelStreamResult,
  StreamPart,
} from "@telorun/ai";
import {
  Stream,
  type ControllerContext,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import { readingParts, building, callLabel, openMessagesStream } from "./anthropic-endpoint.js";
import { buildBody, publishedConfig, type MessagesResource } from "./messages-request.js";
import { streamParts } from "./messages-stream.js";

/**
 * Anthropic's Messages API, for the `Ai.ModelStream` abstract: one request, the
 * answer as parts while it is written.
 *
 * The request is built by the call, so every refusal the request alone decides
 * rejects the call with nothing on the wire. It is SENT at the first pull: a
 * stream nobody reads opens nothing, and everything the endpoint does — its
 * refusal of the request included — rejects the iteration.
 */
class MessagesModelStreamInstance implements ResourceInstance, AiModelStreamInstance {
  constructor(private readonly resource: MessagesResource) {}

  snapshot(): Record<string, unknown> {
    return publishedConfig(this.resource);
  }

  async invoke(input: ModelInvokeInput, ctx?: InvokeContext): Promise<ModelStreamResult> {
    const label = callLabel("Anthropic messages stream", this.resource.metadata.name);
    const body = building(label, ctx, () => ({
      ...buildBody(this.resource, input, label),
      stream: true,
    }));
    return { output: new Stream(this.parts(body, label, ctx)) };
  }

  private async *parts(
    body: Record<string, unknown>,
    label: string,
    ctx: InvokeContext | undefined,
  ): AsyncGenerator<StreamPart> {
    const stream = await openMessagesStream(
      this.resource.request,
      label,
      { body, betas: this.resource.betas },
      ctx,
    );
    yield* readingParts(label, ctx, streamParts(stream, this.resource, label, ctx));
  }
}

export function register(ctx: ControllerContext): void {}

export async function create(
  resource: MessagesResource,
  ctx: ResourceContext,
): Promise<MessagesModelStreamInstance> {
  return new MessagesModelStreamInstance(resource);
}
