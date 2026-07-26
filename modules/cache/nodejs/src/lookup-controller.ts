import type { KindRef, ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";
import { type CacheLookupResult, type CacheStore, isCacheStore } from "./cache-store.js";

interface LookupResource {
  metadata: { name: string; module?: string };
  store?: CacheStore | KindRef<CacheStore>;
}

interface LookupInputs {
  key: string;
}

class CacheLookup implements ResourceInstance<LookupInputs, CacheLookupResult> {
  constructor(
    private readonly resource: LookupResource,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(inputs: LookupInputs): Promise<CacheLookupResult> {
    if (!inputs || typeof inputs.key !== "string") {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Cache.Lookup "${this.resource.metadata.name}": 'key' must be a string.`,
      );
    }
    const store = this.ctx.resolveRef(
      this.resource.store,
      isCacheStore,
      () => `Cache.Lookup "${this.resource.metadata.name}": 'store'`,
      "std/cache#Store",
    );
    return store.get(inputs.key);
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: LookupResource,
  ctx: ResourceContext,
): Promise<CacheLookup> {
  return new CacheLookup(resource, ctx);
}
