import type { ResourceContext } from "@telorun/sdk";
import { type CacheStore, isCacheStore } from "./cache-store.js";

interface StoreRef {
  name: string;
  alias?: string;
}

/**
 * Resolve a `store` field to a live {@link CacheStore}. A local `!ref` is
 * Phase-5-injected as the instance itself; a cross-module `!ref Alias.store`
 * arrives as a raw `{name, alias}` and routes through the import's exported
 * scope. Mirrors `sql`'s `resolveSqlConnection`.
 */
export function resolveCacheStore(
  value: CacheStore | StoreRef | undefined,
  ctx: ResourceContext,
): CacheStore {
  if (isCacheStore(value)) {
    return value;
  }
  const ref = value as StoreRef | undefined;
  if (!ref || typeof ref.name !== "string") {
    throw new Error("Cache: 'store' must reference a cache store resource.");
  }
  if (ref.alias && ref.alias !== "Self") {
    const instance = ctx.moduleContext.resolveImportedInstance(ref.alias, ref.name);
    if (!isCacheStore(instance)) {
      throw new Error(
        `Cache: store reference '${ref.alias}.${ref.name}' did not resolve to an exported store instance.`,
      );
    }
    return instance;
  }
  const instance = ctx.moduleContext.getInstance(ref.name);
  if (!isCacheStore(instance)) {
    throw new Error(`Cache: store reference '${ref.name}' did not resolve to a store instance.`);
  }
  return instance;
}
