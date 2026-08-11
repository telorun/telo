import {
  type KindRef,
  type ControllerContext,
  type ResourceContext,
  type ResourceInstance,
  SEVERITY,
  parseDurationMs,
} from "@telorun/sdk";
import { type CacheStore, isCacheStore } from "@telorun/cache";

interface GuardResource {
  metadata: { name: string; module?: string };
  store?: CacheStore | KindRef<CacheStore>;
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
      // The caller sees an ordinary denial, indistinguishable from a real
      // throttle — so without this the authoring error reads as a working rate
      // limiter that rejects everything.
      this.ctx.log.warn(
        "Denied a call with a missing or empty 'key'; every request is rejected until the " +
          "caller supplies one",
      );
      return { allowed: false, remaining: 0, retryAfter: Math.ceil(this.windowMs / 1000) };
    }
    const store = this.ctx.resolveRef(
      this.resource.store,
      isCacheStore,
      () => `RateLimit.Guard "${this.resource.metadata.name}": 'store'`,
      "std/cache#Store",
    );
    const bucketKey = `ratelimit:${this.resource.metadata.name}:${inputs.key}`;
    const now = Date.now();
    const cutoff = now - this.windowMs;

    const cached = await store.get(bucketKey);
    const prior = cached.state !== "miss" && Array.isArray(cached.value) ? (cached.value as number[]) : [];
    const log = prior.filter((t) => t > cutoff);

    if (log.length >= this.resource.limit) {
      const retryAfter = Math.max(1, Math.ceil((log[0] + this.windowMs - now) / 1000));
      // `debug`, not `info`, even though a throttle is the event this resource
      // exists to produce: absorbing a flood is its job, so one default-visible
      // record per rejection makes the log the amplification target the limiter
      // is there to prevent. Sampling is off by default (§15), so nothing else
      // would bound it. An operator diagnosing throttling raises this module's
      // import to `level: debug`.
      if (this.ctx.log.enabled(SEVERITY.debug)) {
        this.ctx.log.debug("Rate limit exceeded", {
          "ratelimit.key": inputs.key,
          "ratelimit.limit": this.resource.limit,
          "ratelimit.retry_after": retryAfter,
        });
      }
      return { allowed: false, remaining: 0, retryAfter };
    }

    log.push(now);
    await store.set(bucketKey, log, this.windowMs, 0);
    const remaining = this.resource.limit - log.length;
    if (this.ctx.log.enabled(SEVERITY.debug)) {
      this.ctx.log.debug("Rate limit allowed", {
        "ratelimit.key": inputs.key,
        "ratelimit.remaining": remaining,
      });
    }
    return { allowed: true, remaining, retryAfter: 0 };
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
