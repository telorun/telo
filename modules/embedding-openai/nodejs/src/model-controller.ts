import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import type { EmbedRequest, EmbedResult, EmbeddingModel } from "@telorun/embedding";

/**
 * OpenAI-compatible provider for the Embedding.Model abstract. Speaks the
 * OpenAI `/embeddings` HTTP API directly (no vendor SDK), so the same
 * controller serves OpenAI plus every OpenAI-compatible endpoint (Azure OpenAI,
 * vLLM, …) via `baseUrl`. OpenAI embeddings are symmetric — the query/passage
 * intent has no wire parameter, so it is accepted and ignored.
 *
 * Options merging: this manifest's `options` → caller-supplied `options`.
 * Shallow merge, caller wins.
 */

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

interface OpenaiEmbeddingResource {
  metadata: { name: string; module?: string };
  model: string;
  apiKey: string;
  baseUrl?: string;
  dimensions?: number;
  options?: Record<string, unknown>;
}

interface OpenAiEmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

class OpenaiEmbeddingModel implements ResourceInstance, EmbeddingModel {
  private readonly baseUrl: string;

  constructor(private readonly resource: OpenaiEmbeddingResource) {
    this.baseUrl = (resource.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  async embed(request: EmbedRequest): Promise<EmbedResult> {
    const body: Record<string, unknown> = {
      model: this.resource.model,
      input: request.texts,
      ...(this.resource.dimensions !== undefined ? { dimensions: this.resource.dimensions } : {}),
      ...(this.resource.options ?? {}),
      ...(request.options ?? {}),
    };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.resource.apiKey) headers["authorization"] = `Bearer ${this.resource.apiKey}`;

    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await errorMessage(res, "OpenAI embeddings"));

    const data = (await res.json()) as OpenAiEmbeddingResponse;
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
      ...(this.resource.baseUrl ? { baseUrl: this.resource.baseUrl } : {}),
      ...(this.resource.dimensions !== undefined ? { dimensions: this.resource.dimensions } : {}),
      apiKey: this.resource.apiKey ? "[redacted]" : this.resource.apiKey,
    };
  }
}

/** Build an actionable error message from a non-OK response, preferring the
 *  provider's `{ error: { message } }` body and falling back to the raw text. */
async function errorMessage(res: Response, label: string): Promise<string> {
  let detail = "";
  try {
    detail = await res.text();
  } catch {
    // Body already consumed or unavailable — status line is all we have.
  }
  if (detail) {
    try {
      const parsed = JSON.parse(detail) as { error?: { message?: string } };
      if (typeof parsed.error?.message === "string") detail = parsed.error.message;
    } catch {
      // Non-JSON body (gateway HTML, plain text) — keep it verbatim.
    }
  }
  return `${label} failed (${res.status} ${res.statusText})${detail ? `: ${detail}` : ""}`;
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: OpenaiEmbeddingResource,
  _ctx: ResourceContext,
): Promise<OpenaiEmbeddingModel> {
  return new OpenaiEmbeddingModel(resource);
}
