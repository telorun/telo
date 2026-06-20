import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";
import type { EmbedResult, EmbeddingIntent, EmbeddingModel } from "./embedding-model.js";
import { resolveEmbeddingModel } from "./embedding-model-ref.js";

export interface EmbedResource {
  metadata: { name: string; module?: string };
  model?: EmbeddingModel | { name: string; alias?: string };
  options?: Record<string, unknown>;
}

export interface EmbedInputs {
  input: string | string[];
}

const KIND_LABEL: Record<EmbeddingIntent, string> = {
  query: "Embedding.Query",
  passage: "Embedding.Passage",
};

/**
 * Shared implementation for the Query and Passage invocables. They differ only
 * in the fixed retrieval `intent` passed to the backend — everything else
 * (input normalization, model resolution, result shape) is identical.
 */
class EmbedInvocable implements ResourceInstance<EmbedInputs, EmbedResult> {
  constructor(
    private readonly intent: EmbeddingIntent,
    private readonly resource: EmbedResource,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(inputs: EmbedInputs): Promise<EmbedResult> {
    const texts = normalizeInput(inputs?.input, this.intent, this.resource.metadata.name);
    const model = resolveEmbeddingModel(this.resource.model, this.ctx);
    return model.embed({ texts, intent: this.intent, options: this.resource.options });
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

function normalizeInput(input: unknown, intent: EmbeddingIntent, name: string): string[] {
  if (typeof input === "string") {
    return [input];
  }
  if (Array.isArray(input) && input.length > 0 && input.every((t) => typeof t === "string")) {
    return input as string[];
  }
  throw new InvokeError(
    "ERR_INVALID_INPUT",
    `${KIND_LABEL[intent]} "${name}": 'input' must be a non-empty string or array of strings.`,
  );
}

/** Build the `register` / `create` controller exports for a fixed intent. */
export function makeEmbedController(intent: EmbeddingIntent): {
  register: (ctx: ControllerContext) => void;
  create: (
    resource: EmbedResource,
    ctx: ResourceContext,
  ) => Promise<ResourceInstance<EmbedInputs, EmbedResult>>;
} {
  return {
    register(_ctx: ControllerContext): void {},
    async create(
      resource: EmbedResource,
      ctx: ResourceContext,
    ): Promise<ResourceInstance<EmbedInputs, EmbedResult>> {
      return new EmbedInvocable(intent, resource, ctx);
    },
  };
}
