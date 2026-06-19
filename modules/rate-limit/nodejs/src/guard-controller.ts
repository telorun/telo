import {
  type ControllerContext,
  type ResourceContext,
  type ResourceInstance,
  parseDurationMs,
} from "@telorun/sdk";
import { type CacheStore, resolveCacheStore } from "@telorun/cache";

interface GuardResource {
  metadata: { name: string; module?: string };
  store?: CacheStore | { name: string; alias?: string };
  limit: number;
  window: string;
}

interface GuardInputs {
  key: string;
}

interface GuardResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
}

/**
 * Sliding-window rate limiter backed by a Cache.Store. The per-key bucket is a
 * log of request timestamps trimmed to the window; a request is allowed while
 * the log is below `limit`. Non-throwing — returns a verdict for the caller to
 * map (e.g. a 429). Not strictly atomic across concurrent calls; acceptable for
 * coarse protection.
 */
class RateLimitGuard implements ResourceInstance<GuardInputs, GuardResult> {
  private readonly windowMs: number;

  constructor(
    private readonly resource: GuardResource,
    private readonly ctx: ResourceContext,
  ) {
    this.windowMs = parseDurationMs(resource.window);
  }

  async invoke(inputs: GuardInputs): Promise<GuardResult> {
    // Fail closed: an empty key must not collapse every caller into one bucket.
    if (!inputs || typeof inputs.key !== "string" || inputs.key.length === 0) {
      return { allowed: false, remaining: 0, retryAfter: Math.ceil(this.windowMs / 1000) };
    }
    const store = resolveCacheStore(this.resource.store, this.ctx);
    const bucketKey = `ratelimit:${this.resource.metadata.name}:${inputs.key}`;
    const now = Date.now();
    const cutoff = now - this.windowMs;

    const cached = await store.get(bucketKey);
    const prior = cached.state !== "miss" && Array.isArray(cached.value) ? (cached.value as number[]) : [];
    const log = prior.filter((t) => t > cutoff);

    if (log.length >= this.resource.limit) {
      const retryAfter = Math.max(1, Math.ceil((log[0] + this.windowMs - now) / 1000));
      return { allowed: false, remaining: 0, retryAfter };
    }

    log.push(now);
    await store.set(bucketKey, log, this.windowMs, 0);
    return { allowed: true, remaining: this.resource.limit - log.length, retryAfter: 0 };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: GuardResource,
  ctx: ResourceContext,
): Promise<RateLimitGuard> {
  return new RateLimitGuard(resource, ctx);
}
