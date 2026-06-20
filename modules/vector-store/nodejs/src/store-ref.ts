import type { ResourceContext } from "@telorun/sdk";
import { type VectorStoreHandle, isVectorStore } from "./store.js";

interface StoreRef {
  name: string;
  alias?: string;
}

/**
 * Resolve a `store` field to a live {@link VectorStoreHandle}. A local `!ref` is
 * Phase-5-injected as the instance itself; a cross-module `!ref Alias.store`
 * arrives as a raw `{name, alias}` and routes through the import's exported
 * scope. Mirrors cache's `resolveCacheStore`.
 */
export function resolveVectorStore(
  value: VectorStoreHandle | StoreRef | undefined,
  ctx: ResourceContext,
): VectorStoreHandle {
  if (isVectorStore(value)) {
    return value;
  }
  const ref = value as StoreRef | undefined;
  if (!ref || typeof ref.name !== "string") {
    throw new Error("VectorStore: 'store' must reference a vector store resource.");
  }
  if (ref.alias && ref.alias !== "Self") {
    const instance = ctx.moduleContext.resolveImportedInstance(ref.alias, ref.name);
    if (!isVectorStore(instance)) {
      throw new Error(
        `VectorStore: store reference '${ref.alias}.${ref.name}' did not resolve to an exported store instance.`,
      );
    }
    return instance;
  }
  const instance = ctx.moduleContext.getInstance(ref.name);
  if (!isVectorStore(instance)) {
    throw new Error(
      `VectorStore: store reference '${ref.name}' did not resolve to a store instance.`,
    );
  }
  return instance;
}
