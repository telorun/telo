import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";
import type { CacheLookupResult, CacheStore } from "./cache-store.js";
import { resolveCacheStore } from "./cache-store-ref.js";

interface LookupResource {
  metadata: { name: string; module?: string };
  store?: CacheStore | { name: string; alias?: string };
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
    const store = resolveCacheStore(this.resource.store, this.ctx);
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
