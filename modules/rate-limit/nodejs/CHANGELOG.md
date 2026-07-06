# @telorun/rate-limit

## 0.3.0

### Minor Changes

- 06c675b: Add `RateLimit.Budget` — a windowed, **weighted** spend budget over a `Cache.Store`, complementing the request-counting `Guard`. Both kinds' `limit` / `window` config fields are now compile-time CEL slots (`x-telo-eval: compile`), so they can be driven from `variables` / env (operator-tuned ceilings). It debits an arbitrary cost (tokens, bytes, any metered resource) in two phases: `reserve` atomically debits a worst-case `amount` up front (refunding + denying if it would exceed `limit`), and `settle` adjusts the reservation to the actual cost, refunding `reserved − amount`. The atomic debit (via the new `Cache.Store.increment`) closes the concurrent-burst race and charge-on-start closes the reserve-then-abandon leak, so `limit` is a hard per-window bound. Fixed window; fails closed on an empty key.

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
