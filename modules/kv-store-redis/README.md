# Durable Store — Redis

`KvStoreRedis.Store` — a [`KvStore.Store`](../kv-store/README.md) backed by Redis.

## Why use this

- **`putIfAbsent` is `SET NX PX`** — atomic at the server, self-expiring, no schema to migrate. Redis removes an expired key, so absent and lapsed are one state and `NX` is the whole condition.
- **The compare-and-* writes are atomic too** — two Lua scripts, so the revision check and the write are one step. A client-side get-then-set would let a stale writer clobber a record its successor already published.
- **Only two scripts, and both are generic** — they compare a revision and know nothing about what the value means, so every consumer reuses them.
- **Natural fit where Redis already runs** — no new dependency for a deployment that has one.

## Fields

| Field | Purpose |
| --- | --- |
| `url` | Redis connection URL (`redis://localhost:6379`, `rediss://…`). |
| `keyPrefix` | Prefix on every key (default `telo:kv:`), so unrelated key spaces can share one instance. |
| `connectTimeout` | How long to wait for a connection before failing (default `2s`). |

## Example

```yaml
kind: KvStoreRedis.Store
metadata: { name: store }
url: !cel "secrets.redisUrl"
keyPrefix: "app:idem:"
---
kind: Idempotency.Once
metadata: { name: chargeOnce }
store: !ref store
claimTtl: "2m"
ttl: "24h"
invoke: !ref chargePayment
```

## Configure Redis without volatile eviction

Redis key expiry is what implements the claim and retention windows — that is intended. What must **not** happen is Redis dropping a live key for its own reasons. Run the instance with an eviction policy that cannot discard keys under memory pressure:

```
maxmemory-policy noeviction
```

Under `allkeys-lru` (or any `allkeys-*` policy) a settled record can be evicted before its retention window ends, and the operation it recorded may then run a second time. That is precisely the failure this abstract exists to prevent.

## No fallback store

Unlike `CacheRedis.Store`, this store has no `fallback`. Cache failover is safe — a miss just recomputes — but a conditional write served from a second, unsynchronised store would let two callers each believe they won. When Redis is unreachable, operations fail loudly rather than degrading into a wrong answer.
