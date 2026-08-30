import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import type { EmbedRequest, EmbedResult, EmbeddingModel, EmbeddingPrompts } from "@telorun/embedding";
import { applyEmbeddingPrompt, resolveEmbeddingPrompts } from "@telorun/embedding";
import { callOpenAi, type HttpRequestInstance } from "./openai-endpoint.js";

/**
 * OpenAI-compatible provider for the Embedding.Model abstract. Speaks the
 * OpenAI `/embeddings` HTTP API directly (no vendor SDK), so the same
 * controller serves OpenAI plus every OpenAI-compatible endpoint (Azure OpenAI,
 * vLLM, text-embeddings-inference, …) via the client's `baseUrl`.
 *
 * The OpenAI models themselves are symmetric — no wire parameter carries the
 * query/passage intent. Self-hosted checkpoints served over the same API are
 * often not: embeddinggemma, E5 and BGE encode the intent as a text prefix.
 * `queryPrompt` / `passagePrompt` (inherited from Embedding.Model) express that
 * declaratively, so the intent reaches an asymmetric model without this
 * controller knowing which checkpoint is behind the endpoint.
 *
 * Options merging: this manifest's `options` → caller-supplied `options`.
 * Shallow merge, caller wins.
 */

interface OpenaiEmbeddingResource extends EmbeddingPrompts {
  metadata: { name: string; module?: string };
  model: string;
  /** Injected by Phase 5 — the base URL and credential live on its client. */
  request: HttpRequestInstance;
  dimensions?: number;
  options?: Record<string, unknown>;
}

interface OpenAiEmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

class OpenaiEmbeddingModel implements ResourceInstance, EmbeddingModel {
  private readonly prompts: EmbeddingPrompts;

  constructor(private readonly resource: OpenaiEmbeddingResource) {
    this.prompts = resolveEmbeddingPrompts(
      resource,
      `OpenAI.EmbeddingModel "${resource.metadata.name}"`,
    );
  }

  async embed(request: EmbedRequest): Promise<EmbedResult> {
    const texts = applyEmbeddingPrompt(request.texts, request.intent, this.prompts);
    const body: Record<string, unknown> = {
      model: this.resource.model,
      input: texts,
      ...(this.resource.dimensions !== undefined ? { dimensions: this.resource.dimensions } : {}),
      ...(this.resource.options ?? {}),
      ...(request.options ?? {}),
    };
    const data = (await callOpenAi(
      this.resource.request,
      this.resource.metadata.name,
      "OpenAI embeddings",
      { path: "/embeddings", body },
    )) as OpenAiEmbeddingResponse;
    const embeddings = (data.data ?? []).map((d) => d.embedding ?? []);
    if (embeddings.length !== request.texts.length) {
      throw new Error(
        `OpenAI embeddings: expected ${request.texts.length} vectors, received ${embeddings.length}.`,
      );
    }
    return {
      embeddings,
      dimensions: embeddings[0]?.length ?? this.resource.dimensions ?? 0,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
    };
  }

  async provide(): Promise<OpenaiEmbeddingModel> {
    return this;
  }

  snapshot(): Record<string, unknown> {
    return {
      model: this.resource.model,
      ...(this.resource.dimensions !== undefined ? { dimensions: this.resource.dimensions } : {}),
      ...(this.prompts.queryPrompt !== undefined
        ? { queryPrompt: this.prompts.queryPrompt }
        : {}),
      ...(this.prompts.passagePrompt !== undefined
        ? { passagePrompt: this.prompts.passagePrompt }
        : {}),
    };
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: OpenaiEmbeddingResource,
  _ctx: ResourceContext,
): Promise<OpenaiEmbeddingModel> {
  return new OpenaiEmbeddingModel(resource);
}
