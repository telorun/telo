export type {
  EmbeddingIntent,
  EmbeddingUsage,
  EmbedRequest,
  EmbedResult,
  EmbeddingModel,
} from "./embedding-model.js";
export { isEmbeddingModel } from "./embedding-model.js";
export type { EmbeddingPrompts } from "./embedding-prompt.js";
export { applyEmbeddingPrompt, resolveEmbeddingPrompts } from "./embedding-prompt.js";

// Controller entry points. Each kind's `controllers:` candidate selects one of
// these by PURL fragment, so the whole module is one bundle and its shared
// state is one module scope.
export * as PassageController from "./passage-controller.js";
export * as QueryController from "./query-controller.js";
