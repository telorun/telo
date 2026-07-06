# @telorun/cache-redis

## 0.3.0

### Minor Changes

- 06c675b: Add `increment(key, delta, ttlMs)` to the `Cache.Store` contract — a race-free atomic counter that returns the new total, starts a missing key at 0, and sets its `ttlMs` expiry only when the counter is first created this window (fixed window; later increments don't extend it). The memory backend is atomic within the event loop; the Redis backend uses an `INCRBY` + conditional `PEXPIRE` Lua script. This backs correct reserve/settle counters (spend budgets, quotas, metrics) that a `get`-then-`set` read-modify-write could not do without racing. `isCacheStore` now also checks for `increment`, so any external `CacheStore` implementation must add it.

### Patch Changes

- Updated dependencies [06c675b]
  - @telorun/cache@0.3.0

## 0.2.0

### Minor Changes

- 95f168e: Cache, rate-limit, and background-task primitives, plus a comprehensive URL-shortener example.

  - New `cache` family: the backend-pluggable `Cache.Store` abstract with `Cache.Lookup` / `Cache.Entry` (freshness-aware: `ttl` fresh window + optional `staleTtl` grace window, `state` of `miss`/`fresh`/`stale`) and the `Cache.View` read-through decorator (single-flight background revalidation). Backends ship as `cache-memory` (`CacheMemory.Store`) and `cache-redis` (`CacheRedis.Store`, with observable degrade-to-`fallback`).
  - New `rate-limit` module: `RateLimit.Guard`, a non-throwing sliding-window limiter whose counters live in any `Cache.Store`.
  - `run` gains `Run.Detach` (generic, zero-config fire-and-forget).
  - SDK + kernel: `ResourceContext.runDetached(fn)` runs a function detached from the caller's cancellation/trace scope; the kernel tracks each detached task against its owning resource and drains it (bounded) when that resource tears down, routing failures to the EventBus. Used by `Run.Detach` and `Cache.View`'s background revalidation.
  - `http-server`: `Http.Server.trustProxy` and a derived `request.ip` in the handler CEL context (canonical client address for rate-limit keys).

### Patch Changes

- Updated dependencies [95f168e]
  - @telorun/cache@0.2.0
