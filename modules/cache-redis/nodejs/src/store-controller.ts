import {
  type ControllerContext,
  type ResourceContext,
  type ResourceInstance,
  parseDurationMs,
} from "@telorun/sdk";
import { type CacheLookupResult, type CacheStore, resolveCacheStore } from "@telorun/cache";
import { Redis } from "ioredis";

interface StoreResource {
  metadata: { name: string; module?: string };
  url: string;
  fallback?: CacheStore | { name: string; alias?: string };
  connectTimeout?: string;
  keyPrefix?: string;
}

interface Envelope {
  value: unknown;
  storedAt: number;
  freshUntil: number;
  expireAt: number;
}

const MISS: CacheLookupResult = { state: "miss", value: null, age: null };

/**
 * Redis-backed cache store. Each entry is a JSON envelope (value + fresh/stale
 * timestamps) with a Redis TTL bounding its lifetime; freshness is classified
 * on read like the memory backend. When Redis is unreachable it degrades to an
 * optional `fallback` store (logged + surfaced via `cache.degraded`) and
 * recovers on the next successful op (`cache.recovered`). With no fallback the
 * error is surfaced, never swallowed.
 */
class RedisStore implements ResourceInstance, CacheStore {
  private readonly redis: Redis;
  private readonly keyPrefix: string;
  private fallback?: CacheStore;
  private degraded = false;

  constructor(
    private readonly resource: StoreResource,
    private readonly ctx: ResourceContext,
  ) {
    this.keyPrefix = resource.keyPrefix ?? "";
    this.redis = new Redis(resource.url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: parseDurationMs(resource.connectTimeout ?? "2s"),
      // Individual commands fail fast to the fallback (offline queue off,
      // 1 retry), but keep reconnecting in the background with bounded backoff
      // so the store recovers (and emits `cache.recovered`) when Redis returns.
      retryStrategy: (times) => Math.min(times * 200, 2000),
    });
    // ioredis requires an 'error' listener or it throws unhandled; route it
    // through the same observable degrade path (debounced by the flag).
    this.redis.on("error", () => {
      void this.enterDegraded();
    });
  }

  async init(): Promise<void> {
    this.fallback = this.resolveFallback();
    try {
      await this.redis.connect();
    } catch {
      await this.enterDegraded();
    }
  }

  private key(key: string): string {
    return this.keyPrefix + key;
  }

  async get(key: string): Promise<CacheLookupResult> {
    try {
      const raw = await this.redis.get(this.key(key));
      await this.exitDegraded();
      if (raw === null) return MISS;
      const env = JSON.parse(raw) as Envelope;
      const now = Date.now();
      if (now >= env.expireAt) {
        await this.redis.del(this.key(key));
        return MISS;
      }
      return { state: now < env.freshUntil ? "fresh" : "stale", value: env.value, age: now - env.storedAt };
    } catch (err) {
      return this.onFailure(err, () => this.fallback!.get(key));
    }
  }

  async set(key: string, value: unknown, ttlMs: number, staleTtlMs: number): Promise<void> {
    const now = Date.now();
    const env: Envelope = { value, storedAt: now, freshUntil: now + ttlMs, expireAt: now + ttlMs + staleTtlMs };
    const ttlSec = Math.max(1, Math.ceil((ttlMs + staleTtlMs) / 1000));
    try {
      await this.redis.set(this.key(key), JSON.stringify(env), "EX", ttlSec);
      await this.exitDegraded();
    } catch (err) {
      await this.onFailure(err, () => this.fallback!.set(key, value, ttlMs, staleTtlMs));
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.redis.del(this.key(key));
      await this.exitDegraded();
    } catch (err) {
      await this.onFailure(err, () => this.fallback!.delete(key));
    }
  }

  // INCRBY + set-expiry-if-none in one atomic Lua script: race-free across
  // concurrent callers, and the fixed window is set only when the counter is
  // first created (PTTL < 0), never extended by later increments.
  async increment(key: string, delta: number, ttlMs: number): Promise<number> {
    const LUA =
      "local v = redis.call('INCRBY', KEYS[1], ARGV[1]); " +
      "if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end; " +
      "return v";
    try {
      const total = await this.redis.eval(LUA, 1, this.key(key), String(Math.trunc(delta)), String(ttlMs));
      await this.exitDegraded();
      return Number(total);
    } catch (err) {
      return this.onFailure(err, () => this.fallback!.increment(key, delta, ttlMs));
    }
  }

  /** On a Redis failure: enter degraded mode (observable). Serve from the
   *  fallback if configured, else surface the error — never swallow it. */
  private async onFailure<T>(err: unknown, fromFallback: () => Promise<T>): Promise<T> {
    await this.enterDegraded();
    if (!this.fallback) throw err;
    return fromFallback();
  }

  private async enterDegraded(): Promise<void> {
    if (this.degraded) return;
    this.degraded = true;
    await this.ctx.emitEvent("cache.degraded", {
      store: this.resource.metadata.name,
      fallback: this.fallback ? "memory" : null,
    });
  }

  private async exitDegraded(): Promise<void> {
    if (!this.degraded) return;
    this.degraded = false;
    await this.ctx.emitEvent("cache.recovered", { store: this.resource.metadata.name });
  }

  private resolveFallback(): CacheStore | undefined {
    if (this.resource.fallback === undefined) return undefined;
    return resolveCacheStore(this.resource.fallback, this.ctx);
  }

  async provide(): Promise<RedisStore> {
    return this;
  }

  async teardown(): Promise<void> {
    this.redis.disconnect();
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(resource: StoreResource, ctx: ResourceContext): Promise<RedisStore> {
  return new RedisStore(resource, ctx);
}
