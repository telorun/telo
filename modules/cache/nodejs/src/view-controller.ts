import type { KindRef, ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import {
  InvokeError,
  SEVERITY,
  parseDurationMs,
  resolveInvocableDispatcher,
} from "@telorun/sdk";
import { type CacheLookupResult, type CacheStore, isCacheStore } from "./cache-store.js";

type RevalidateMode = "background" | "sync" | "off";

interface ViewResource {
  metadata: { name: string; module?: string };
  store?: CacheStore | KindRef<CacheStore>;
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
    const store = this.ctx.resolveRef(
      this.resource.store,
      isCacheStore,
      () => `Cache.View "${this.resource.metadata.name}": 'store'`,
      "std/cache#Store",
    );
    const cached = await store.get(key);

    if (cached.state === "fresh") {
      this.logOutcome("served from cache", key, cached.age);
      return cached;
    }

    if (cached.state === "stale") {
      if (this.revalidate === "background") {
        this.logOutcome("served stale, revalidating in the background", key, cached.age);
        this.scheduleBackground(key, inputs, store);
        return cached;
      }
      if (this.revalidate === "sync") {
        try {
          const value = await this.loadAndStore(key, inputs, store);
          this.logOutcome("revalidated before returning", key, cached.age);
          return { state: "stale", value, age: 0 };
        } catch (err) {
          // stale-if-error: keep serving the stale value. The caller gets a
          // successful response and never learns the upstream is down, so this
          // is the only place the failure can be reported at all.
          this.ctx.log.warn(
            "Revalidation failed; serving the stale value",
            { "cache.key": key, "cache.age": cached.age },
            { error: err },
          );
          return cached;
        }
      }
      // "off": ignore the stale value, reload as for a miss.
    }

    const value = await this.loadAndStore(key, inputs, store);
    this.logOutcome("called through", key);
    return { state: "miss", value, age: 0 };
  }

  /**
   * One record per lookup, naming what the view actually DID. `debug`, because
   * serving a hit is routine — the notable outcome, a revalidation that failed,
   * warns instead.
   *
   * The action is not recoverable from the returned state: a `stale` result may
   * or may not have triggered a revalidation depending on `revalidate`, and with
   * `revalidate: off` a stale entry is reported to the caller as a `miss`. It is
   * also not recoverable from the trace, which is off by default.
   */
  private logOutcome(action: string, key: string, age?: number | null): void {
    if (!this.ctx.log.enabled(SEVERITY.debug)) return;
    // A null age is "unknown", not a reading — omitted rather than reported.
    this.ctx.log.debug(
      action,
      typeof age === "number" ? { "cache.key": key, "cache.age": age } : { "cache.key": key },
    );
  }

  private scheduleBackground(key: string, inputs: ViewInputs, store: CacheStore): void {
    if (this.revalidating.has(key)) return; // single-flight per key
    this.revalidating.add(key);
    // Fire-and-forget: the kernel tracks this task against this resource and
    // drains it on teardown.
    this.ctx.runDetached(async () => {
      try {
        await this.loadAndStore(key, inputs, store);
      } catch (err) {
        // Reported here rather than rethrown into the kernel's unhandled-detached
        // net: the key is the actionable half and only this frame has it, and a
        // background revalidation that fails is the same degraded-but-correct
        // condition the `sync` branch reports above — the stale value keeps
        // serving either way, so both modes report it identically.
        this.ctx.log.warn(
          "Background revalidation failed; the stale value keeps serving until it expires",
          { "cache.key": key },
          { error: err },
        );
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
