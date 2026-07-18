export type {
  EmbeddingIntent,
  EmbeddingUsage,
  EmbedRequest,
  EmbedResult,
  EmbeddingModel,
} from "./embedding-model.js";
export { isEmbeddingModel } from "./embedding-model.js";
export { resolveEmbeddingModel } from "./embedding-model-ref.js";
export type { EmbeddingPrompts } from "./embedding-prompt.js";
export { applyEmbeddingPrompt, resolveEmbeddingPrompts } from "./embedding-prompt.js";
