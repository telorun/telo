# @telorun/lease

## 0.4.0

### Minor Changes

- adc8459: Back `Lease.Critical` with `KvStore.Store` instead of `Cache.Store`.

  A cache is a freshness contract and evictable by design, so an evicted lease
  record let two holders run the body — the exact failure a lease exists to
  prevent. The durable store is non-evicting by contract, and its atomic `claim`
  replaces the previous counter-plus-holder-key emulation with a single operation,
  removing the read-then-write gap between them.

  `store:` now references `std/kv-store#Store`; point it at
  `kv-store-sql` or `kv-store-redis` for cross-instance exclusion, or
  `kv-store-memory` for single-process use. The package no longer depends on
  `@telorun/cache`.

  The mutex now runs on `KeyedClaim`, so the ownership guard is shared rather than
  reimplemented, and `release` is guarded by the record's revision instead of the
  holder token — a holder whose lease already lapsed cannot free its successor's.

  A key holding a SETTLED record raises rather than reporting a permanent,
  holder-less denial: a lease never settles, so it means another consumer of the
  shared store is using a colliding key — a cause worth naming instead of a denial
  that cannot be diagnosed.

### Patch Changes

- Updated dependencies [adc8459]
  - @telorun/kv-store@0.2.0

## 0.3.0

### Minor Changes

- 721a241: `Lease.Critical` learns `op: cancel`: a running **detached** body can be ended
  early by invoking the lease with `{ op: cancel, key, holder? }`. The body runs
  under a lease-owned cancellation scope, so the cancel trips its cancellation
  token — every honoring leaf (a model call, a `Timer.Delay`, a fetch) aborts —
  and the lease releases on the body's terminal. The `holder` guard refuses a
  stale cancel aimed at a newer occupant of the key, and a body ending because it
  was cancelled is treated as an expected terminal, not a detached failure.

  SDK: `resolveInvocableDispatcher`'s returned thunk accepts an optional
  `InvokeContext` second argument, letting a decorator seed the dispatch's
  cancellation scope (backwards compatible — omitted means the ambient context
  applies unchanged).

### Patch Changes

- @telorun/cache@0.3.0

## 0.2.0

### Minor Changes

- 06c675b: New `lease` module: `Lease.Critical`, a declarative critical section over a `Cache.Store`. It wraps a body and owns the whole acquire → run → release lifecycle (like `Cache.View` wraps caching), so manifests never issue imperative acquire/release calls. At most one holder per `key`; a second attempt reports the current `holder` instead of running the body (branch on `acquired` — skip, or return 409). Leases are time-bounded (`ttl`, self-healing on holder death) and race-free via `Cache.Store.increment`. Two modes: synchronous (release on body return — cron overlap, migrations, singleflight) and `detach: true` (dispatch the body detached, hold the lease across it, release on its terminal — "one background operation per key," e.g. a per-conversation agent turn).

### Patch Changes

- Updated dependencies [06c675b]
  - @telorun/cache@0.3.0
