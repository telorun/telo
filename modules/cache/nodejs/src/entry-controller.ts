import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError, parseDurationMs } from "@telorun/sdk";
import type { CacheStore } from "./cache-store.js";
import { resolveCacheStore } from "./cache-store-ref.js";

interface EntryResource {
  metadata: { name: string; module?: string };
  store?: CacheStore | { name: string; alias?: string };
  ttl?: string;
  staleTtl?: string;
}

interface EntryInputs {
  key: string;
  value: unknown;
}

class CacheEntry implements ResourceInstance<EntryInputs, { key: string }> {
  private readonly ttlMs: number;
  private readonly staleTtlMs: number;

  constructor(
    private readonly resource: EntryResource,
    private readonly ctx: ResourceContext,
  ) {
    this.ttlMs = parseDurationMs(resource.ttl);
    this.staleTtlMs = parseDurationMs(resource.staleTtl);
  }

  async invoke(inputs: EntryInputs): Promise<{ key: string }> {
    if (!inputs || typeof inputs.key !== "string") {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Cache.Entry "${this.resource.metadata.name}": 'key' must be a string.`,
      );
    }
    const store = resolveCacheStore(this.resource.store, this.ctx);
    await store.set(inputs.key, inputs.value, this.ttlMs, this.staleTtlMs);
    return { key: inputs.key };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(resource: EntryResource, ctx: ResourceContext): Promise<CacheEntry> {
  return new CacheEntry(resource, ctx);
}
