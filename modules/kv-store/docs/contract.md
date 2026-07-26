---
description: "The KvStore.Store contract: four conditional-write primitives, the guarantees a backend owes, and the KeyedClaim protocol built on top of them."
sidebar_label: Store contract
---

# `KvStore.Store` contract

This is the normative definition of the abstract. A backend that cannot meet the guarantees below — above all, atomic conditional writes — must not implement it.

## What this is, and what it deliberately is not

It is a **key/value store**. It is not a lock, a lease, or an idempotency record; those are *protocols*, and they live one layer up in [`KeyedClaim`](#the-keyedclaim-protocol).

That split is deliberate and was learned the hard way. An earlier shape exposed `claim` / `renew` / `settle` / `release` as the abstract, which pushed one state machine into every backend: the identical ownership guard ended up written three times — in JavaScript, in SQL `WHERE` clauses, and in Lua. Three expressions of one rule is three times the surface for a bug that admits a second holder. Four primitives instead mean a backend implements only what its engine already does natively.

## Operations

```
get(key)                                            → { value, version } | null
putIfAbsent(key, value, ttlMs)                      → { value, version } | null
compareAndSet(key, expectedVersion, value, ttlMs)   → { value, version } | null
compareAndDelete(key, expectedVersion)              → boolean
```

`version` is an **opaque, store-generated token** naming one exact revision of a record. Never parse it, never order by it. Handing it back to a conditional write is how a caller says "only if nothing has changed since I looked".

### `get`

The current record, or `null` when the key is absent **or its TTL has lapsed** — expired and absent are the same state to every operation here.

A read is advisory: acting on it is a race. Branch on a conditional write's return instead.

### `putIfAbsent`

**Atomic.** Writes only when the key is free — absent, or holding a lapsed record. Returns the new revision, or `null` when someone else holds it.

Losing is an *outcome*, not an error. A caller learns it lost from the `null`, not from an exception, so contention never needs a `try`.

This must be one operation at the backend: a unique-key `INSERT … ON CONFLICT`, a Redis `SET NX PX`, or equivalent. A read followed by a write is **not** an implementation — two callers can both read "free" before either writes.

### `compareAndSet`

**Atomic.** Replaces the record only if it is still at `expectedVersion`, and refreshes its TTL. Returns the new revision, or `null` when the version no longer matches — someone else wrote, or the record lapsed.

This is also how a holder extends a TTL: compare-and-set the same value.

### `compareAndDelete`

Deletes only if the record is still at `expectedVersion`.

## Guarantees a backend owes

1. **`putIfAbsent` and `compareAndSet` are atomic** across every process sharing the backend.
2. **No eviction before the TTL.** A record survives its full window. A backend that discards under memory pressure cannot implement this abstract, because a dropped record silently permits work to happen twice. For Redis that means `maxmemory-policy noeviction`.
3. **Failure surfaces.** A backend that cannot complete an operation raises. It never reports a write it did not make — and it never uses an exception to report mere contention, which is what the `null` return is for.

## Not a cache

`Cache.Store` is also a key/value store. The difference is not the operations but the guarantees:

| | `Cache.Store` | `KvStore.Store` |
| --- | --- | --- |
| Contract | Freshness — `miss` / `fresh` / `stale` | Durability + conditional writes |
| Eviction | Expected, under pressure | Forbidden before the TTL |
| Conditional write | None (`increment` is the only atom) | `putIfAbsent`, `compareAndSet` |
| Losing a record | A slower next read | Work happens twice |

Use a cache to avoid recomputing something. Use this when losing the record would let work happen twice.

## The `KeyedClaim` protocol

`KeyedClaim` (exported from `@telorun/kv-store`) implements *claim → renew → settle | release* over any conforming store. Both `Lease.Critical` and `Idempotency.Once` use it, so the state machine exists once rather than per backend.

A key under the protocol holds one of:

| State | Meaning |
| --- | --- |
| **held** | An owner token plus a TTL. It frees on its own when the TTL lapses, so an owner that dies never wedges the key. |
| **settled** | A terminal value retained for a window. |

```
claim(key, holder, claimTtlMs)              → { state: new | held | settled, holder?, value?, version? }
renew(key, version, claimTtlMs)             → ClaimResult | null
settle(key, version, holder, value, ttlMs)  → ClaimResult | null
release(key, version)                       → boolean
read(key)                                   → ClaimResult
```

Every mutating step presents the **version** the caller last saw, so a holder whose claim lapsed cannot touch a record its successor has since written. That guard is what makes TTL-based expiry safe rather than a race, and it is why `renew` returns the new revision: the token advances on every write, and the caller must thread it forward.

## Clock sensitivity

A backend that stores an absolute expiry supplied by the writing process (as `kv-store-sql` does, to keep its SQL dialect-neutral) depends on hosts having roughly aligned clocks: a host running far ahead can consider another writer's record expired early. Keep hosts on NTP and size TTLs above both the work's duration and any expected skew.
