import type { ResourceContext } from "@telorun/sdk";
import { type EmbeddingModel, isEmbeddingModel } from "./embedding-model.js";

interface ModelRef {
  name: string;
  alias?: string;
}

/**
 * Resolve a `model` field to a live {@link EmbeddingModel}. A local `!ref` is
 * Phase-5-injected as the instance itself; a cross-module `!ref Alias.model`
 * arrives as a raw `{name, alias}` and routes through the import's exported
 * scope. Mirrors `cache`'s `resolveCacheStore`.
 */
export function resolveEmbeddingModel(
  value: EmbeddingModel | ModelRef | undefined,
  ctx: ResourceContext,
): EmbeddingModel {
  if (isEmbeddingModel(value)) {
    return value;
  }
  const ref = value as ModelRef | undefined;
  if (!ref || typeof ref.name !== "string") {
    throw new Error("Embedding: 'model' must reference an embedding model resource.");
  }
  if (ref.alias && ref.alias !== "Self") {
    const instance = ctx.moduleContext.resolveImportedInstance(ref.alias, ref.name);
    if (!isEmbeddingModel(instance)) {
      throw new Error(
        `Embedding: model reference '${ref.alias}.${ref.name}' did not resolve to an exported model instance.`,
      );
    }
    return instance;
  }
  const instance = ctx.moduleContext.getInstance(ref.name);
  if (!isEmbeddingModel(instance)) {
    throw new Error(`Embedding: model reference '${ref.name}' did not resolve to a model instance.`);
  }
  return instance;
}
