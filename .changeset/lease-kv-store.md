---
"@telorun/lease": minor
---

Back `Lease.Critical` with `KvStore.Store` instead of `Cache.Store`.

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
