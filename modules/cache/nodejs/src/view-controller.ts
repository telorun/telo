import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError, parseDurationMs, resolveInvocableDispatcher } from "@telorun/sdk";
import type { CacheLookupResult, CacheStore } from "./cache-store.js";
import { resolveCacheStore } from "./cache-store-ref.js";

type RevalidateMode = "background" | "sync" | "off";

interface ViewResource {
  metadata: { name: string; module?: string };
  store?: CacheStore | { name: string; alias?: string };
  invoke?: unknown;
  ttl?: string;
  staleTtl?: string;
  revalidate?: RevalidateMode;
}

interface ViewInputs {
  key: string;
  [k: string]: unknown;
}

/**
 * Read-through cache decorator. Wraps an invocable (`invoke:`); a lookup against
 * `store` decides whether to serve cached or call through:
 *   - fresh → return cached;
 *   - stale → serve cached, and (background) schedule a single-flight detached
 *     revalidation on `tasks`, or (sync) reload before returning with stale-if-
 *     error fallback, or (off) treat as a miss;
 *   - miss  → call through, populate, return.
 */
class CacheView implements ResourceInstance<ViewInputs, CacheLookupResult> {
  private readonly ttlMs: number;
  private readonly staleTtlMs: number;
  private readonly revalidate: RevalidateMode;
  private readonly revalidating = new Set<string>();

  constructor(
    private readonly resource: ViewResource,
    private readonly ctx: ResourceContext,
  ) {
    this.ttlMs = parseDurationMs(resource.ttl);
    this.staleTtlMs = parseDurationMs(resource.staleTtl);
    this.revalidate = resource.revalidate ?? "sync";
  }

  async invoke(inputs: ViewInputs): Promise<CacheLookupResult> {
    if (!inputs || typeof inputs.key !== "string") {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Cache.View "${this.resource.metadata.name}": 'key' must be a string.`,
      );
    }
    const key = inputs.key;
    const store = resolveCacheStore(this.resource.store, this.ctx);
    const cached = await store.get(key);

    if (cached.state === "fresh") return cached;

    if (cached.state === "stale") {
      if (this.revalidate === "background") {
        this.scheduleBackground(key, inputs, store);
        return cached;
      }
      if (this.revalidate === "sync") {
        try {
          const value = await this.loadAndStore(key, inputs, store);
          return { state: "stale", value, age: 0 };
        } catch {
          return cached; // stale-if-error: keep serving the stale value
        }
      }
      // "off": ignore the stale value, reload as for a miss.
    }

    const value = await this.loadAndStore(key, inputs, store);
    return { state: "miss", value, age: 0 };
  }

  private scheduleBackground(key: string, inputs: ViewInputs, store: CacheStore): void {
    if (this.revalidating.has(key)) return; // single-flight per key
    this.revalidating.add(key);
    // Fire-and-forget: the kernel tracks this task against this resource and
    // drains it on teardown.
    this.ctx.runDetached(async () => {
      try {
        await this.loadAndStore(key, inputs, store);
      } finally {
        this.revalidating.delete(key);
      }
    });
  }

  private async loadAndStore(key: string, inputs: ViewInputs, store: CacheStore): Promise<unknown> {
    const value = await this.dispatchTarget(inputs);
    await store.set(key, value, this.ttlMs, this.staleTtlMs);
    return value;
  }

  private async dispatchTarget(inputs: ViewInputs): Promise<unknown> {
    const dispatch = resolveInvocableDispatcher(
      this.resource.invoke,
      this.ctx,
      () => `Cache.View "${this.resource.metadata.name}"`,
    );
    return dispatch(inputs);
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(resource: ViewResource, ctx: ResourceContext): Promise<CacheView> {
  return new CacheView(resource, ctx);
}
