# KV Store

`KvStore.Store` — a durable, **non-evicting** key/value store with **atomic conditional writes**. It is the storage primitive behind at-most-once execution (`Idempotency.Once`) and cross-instance mutual exclusion (`Lease.Critical`).

## Why use this

- **Conditional writes are atomic, not emulated** — `putIfAbsent` is one `INSERT … ON CONFLICT` or one `SET NX`; `compareAndSet` is one guarded `UPDATE` or one Lua script. There is no read-then-write gap, which is exactly where a double execution slips through.
- **Records are not evictable** — a cache may drop anything under memory pressure. Dropping a lease record admits a second holder; dropping a completed idempotency record permits a re-run. This contract forbids both.
- **Contention is a return value, not an exception** — a conditional write that loses returns `null`. Losing a race is an ordinary outcome and needs no `try`.
- **Backends swap without touching consumers** — SQL, Redis, or in-process, chosen per deployment.

## Kinds

| Kind | Purpose |
| --- | --- |
| `KvStore.Store` | The abstract backend contract. Not instantiable — reference an implementation. See [the contract](docs/contract.md). |

## Backends

| Module | Use |
| --- | --- |
| `kv-store-sql` | An `Sql.Connection` — Postgres or SQLite. |
| `kv-store-redis` | Redis, for deployments already running one. |
| `kv-store-memory` | Single process, no durability across restarts. Development and tests only. |

## Example

```yaml
kind: SqlSqlite.Connection
metadata: { name: db }
file: ./data.db
---
kind: KvStoreSql.Store
metadata: { name: store }
connection: !ref db
---
kind: Idempotency.Once
metadata: { name: chargeOnce }
store: !ref store
claimTtl: "2m"
ttl: "24h"
invoke: !ref chargePayment
```

One store backs every consumer that needs a durable conditional write, so a lease and an idempotency key share a backend rather than each standing up their own.

## Storage, not protocol

The abstract is four primitives. Locks, leases and idempotency records are **protocols**, and they live one layer up: `KeyedClaim` (exported from `@telorun/kv-store`) implements *claim → renew → settle | release* once, over any conforming backend.

That split is load-bearing. An earlier version of this module put the claim protocol *in the abstract*, which forced every backend to re-express the same ownership guard — once in JavaScript, once in SQL `WHERE` clauses, once in Lua. Three expressions of one rule is three times the surface for a bug that admits a second holder. Now a backend implements only what its engine already does natively, and the state machine has one home.

It also means a consumer that wants something other than a claim — leader election, a counter, a cursor — uses the store directly instead of asking for the abstract to grow.

## Not a cache

`Cache.Store` is also a key/value store. What separates them is the guarantees, not the operations:

| | `Cache.Store` | `KvStore.Store` |
| --- | --- | --- |
| Contract | Freshness — `miss` / `fresh` / `stale` | Durability + conditional writes |
| Eviction | Expected, under pressure | Forbidden before the TTL |
| Conditional write | None (`increment` is the only atom) | `putIfAbsent`, `compareAndSet` |
| Losing a record | A slower next read | Work happens twice |

Use a cache to avoid recomputing something. Use this when losing the record would let work happen twice.

## Reference

See [the store contract](docs/contract.md) for the operations a backend must implement and the `KeyedClaim` protocol built on them.
