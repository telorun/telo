/** Which side of a retrieval match a text is being embedded for. Asymmetric
 *  models embed a query differently from a stored passage; symmetric models
 *  ignore the distinction. */
export type EmbeddingIntent = "query" | "passage";

export interface EmbeddingUsage {
  promptTokens: number;
  totalTokens: number;
}

export interface EmbedRequest {
  /** The texts to embed, in order. Always a non-empty array. */
  texts: string[];
  /** Retrieval intent the backend maps to its own input-type parameter. */
  intent: EmbeddingIntent;
  /** Per-call provider options, merged over the model's own options. */
  options?: Record<string, unknown>;
}

export interface EmbedResult {
  /** One vector per input text, in input order. */
  embeddings: number[][];
  dimensions: number;
  usage: EmbeddingUsage;
}

/**
 * The contract every embedding backend (EmbeddingOpenai.Model, …) implements.
 * A single `embed` call produces one vector per input text; the backend reads
 * `intent` to pick its query/passage parameter where the model is asymmetric.
 */
export interface EmbeddingModel {
  embed(request: EmbedRequest): Promise<EmbedResult>;
}

/** True when a value already exposes the model contract (Phase-5 injected). */
export function isEmbeddingModel(value: unknown): value is EmbeddingModel {
  return !!value && typeof (value as EmbeddingModel).embed === "function";
}
