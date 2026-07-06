/** The freshness state of a looked-up entry. */
export type CacheState = "miss" | "fresh" | "stale";

export interface CacheLookupResult {
  state: CacheState;
  /** The stored value, or `null` on `miss`. */
  value: unknown;
  /** Milliseconds since the entry was written, or `null` on `miss`. */
  age: number | null;
}

/**
 * The contract every cache backend (CacheMemory.Store, CacheRedis.Store, …)
 * implements. The store owns freshness: `set` records the fresh and stale
 * windows; `get` classifies the entry as fresh / stale / miss against them.
 */
export interface CacheStore {
  get(key: string): Promise<CacheLookupResult>;
  set(key: string, value: unknown, ttlMs: number, staleTtlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * Atomically add `delta` (may be negative) to a numeric counter and return
   * the new total. A key that is missing or expired starts at 0, and its
   * `ttlMs` expiry is set **only when the counter is first created this window**
   * — subsequent increments do not extend it (a fixed window that resets after
   * `ttlMs`). Unlike a `get`-then-`set` read-modify-write this is race-free, so
   * it backs correct reserve/settle counters (rate/spend budgets, quotas,
   * metrics) even under concurrent callers. `delta` must be an integer.
   */
  increment(key: string, delta: number, ttlMs: number): Promise<number>;
}

/** True when a value already exposes the store contract (Phase-5 injected). */
export function isCacheStore(value: unknown): value is CacheStore {
  return (
    !!value &&
    typeof (value as CacheStore).get === "function" &&
    typeof (value as CacheStore).set === "function" &&
    typeof (value as CacheStore).increment === "function"
  );
}
