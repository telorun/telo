# @telorun/cache

## 0.5.0

### Minor Changes

- e52a2bf: Drop the controller entry points from the export map; the package is now the TS contract only.

  Each of these modules delivers its controllers as bundles inside its own module artifact, so the per-controller subpath exports (`./lookup`, `./connection`, …) no longer point at anything a consumer should import. What remains is the surface a third-party backend of the module abstract compiles against — the store / connection / model contracts and their helpers — which is exactly why the package keeps publishing rather than going private like the rest of the standard library.

  Each export also gains a `source` condition naming the TypeScript it is built from, ahead of `import`. A consumer resolving normally still gets `dist/`; a bundler asked for `--conditions=source` inlines the source instead, which is what lets a controller that inlines this package be built without first building it.

## 0.4.0

### Minor Changes

- 942c176: Resolve provider-shaped `!ref` slots through `ctx.resolveRef` instead of a
  per-module copy of the same two-branch logic.

  The removed wrappers (`resolveCacheStore`, `resolveShellHost`,
  `resolveVectorStore`, `resolveEmbeddingModel`, `resolveJournal`) were one-line
  shims; call sites now pass the module's own type guard and the slot's `x-telo-ref`
  contract, so a mis-wire names the owning resource and what the slot wanted —
  `` Cache.Entry "page": 'store' … did not resolve to a resource satisfying
`std/cache#Store`  ``. Each module still
  exports its guard (`isCacheStore`, `isShellHost`, `isVectorStore`,
  `isEmbeddingModel`, `isJournalStore`, `isSqlConnection`) for consumers that
  resolve the slot themselves; `isJournalStore` is now duck-typed rather than
  `instanceof`, so it survives two copies of the package in one process.

  `resolveSqlConnection` stays — it encodes the optional-slot rule that lets a
  `Sql.Query` fall back to its `transaction` — and now takes a `describe` argument,
  so its six call sites report the owning resource instead of a bare `Sql:` prefix.
  Ref-typed manifest fields use the SDK's `KindRef<T>` rather than a hand-rolled
  `{ name, alias }`.

## 0.3.0

### Minor Changes

- 06c675b: Add `increment(key, delta, ttlMs)` to the `Cache.Store` contract — a race-free atomic counter that returns the new total, starts a missing key at 0, and sets its `ttlMs` expiry only when the counter is first created this window (fixed window; later increments don't extend it). The memory backend is atomic within the event loop; the Redis backend uses an `INCRBY` + conditional `PEXPIRE` Lua script. This backs correct reserve/settle counters (spend budgets, quotas, metrics) that a `get`-then-`set` read-modify-write could not do without racing. `isCacheStore` now also checks for `increment`, so any external `CacheStore` implementation must add it.

## 0.2.0

### Minor Changes

- 95f168e: Cache, rate-limit, and background-task primitives, plus a comprehensive URL-shortener example.

  - New `cache` family: the backend-pluggable `Cache.Store` abstract with `Cache.Lookup` / `Cache.Entry` (freshness-aware: `ttl` fresh window + optional `staleTtl` grace window, `state` of `miss`/`fresh`/`stale`) and the `Cache.View` read-through decorator (single-flight background revalidation). Backends ship as `cache-memory` (`CacheMemory.Store`) and `cache-redis` (`CacheRedis.Store`, with observable degrade-to-`fallback`).
  - New `rate-limit` module: `RateLimit.Guard`, a non-throwing sliding-window limiter whose counters live in any `Cache.Store`.
  - `run` gains `Run.Detach` (generic, zero-config fire-and-forget).
  - SDK + kernel: `ResourceContext.runDetached(fn)` runs a function detached from the caller's cancellation/trace scope; the kernel tracks each detached task against its owning resource and drains it (bounded) when that resource tears down, routing failures to the EventBus. Used by `Run.Detach` and `Cache.View`'s background revalidation.
  - `http-server`: `Http.Server.trustProxy` and a derived `request.ip` in the handler CEL context (canonical client address for rate-limit keys).
