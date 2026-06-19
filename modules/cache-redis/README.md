# Cache Redis

`CacheRedis.Store` — a Redis-backed implementation of the [`Cache.Store`](../cache/README.md) abstract, for caching and rate-limit counters shared across instances.

## Why use this

- **Shared** — multiple app instances see the same cache and the same rate-limit counters.
- **Freshness-aware** — stores a JSON envelope with the fresh/stale windows and a Redis TTL; classifies `fresh` / `stale` / `miss` on read like the memory backend.
- **Degrades, observably** — when Redis is unreachable it falls back to an optional `fallback` store (e.g. `CacheMemory.Store`), emits a `cache.degraded` event, and recovers (`cache.recovered`) on the next successful op. With no `fallback`, the error is surfaced — never swallowed.

## Kinds

| Kind | Capability | Purpose |
| --- | --- | --- |
| `CacheRedis.Store` | Provider | Redis cache store; satisfies `Cache.Store`. |

## Fields

| Field | Required | Description |
| --- | --- | --- |
| `url` | yes | Redis URL (`redis://…`, `rediss://…`). |
| `fallback` | no | A `Cache.Store` served while Redis is down (degraded mode). |
| `connectTimeout` | no | Wait before degrading (duration, default `2s`). |
| `keyPrefix` | no | Prefix applied to every key (namespacing a shared Redis). |

## Example

```yaml
imports:
  Cache: std/cache@latest
  CacheMemory: std/cache-memory@latest
  CacheRedis: std/cache-redis@latest
---
kind: CacheMemory.Store
metadata: { name: Local }       # in-process fallback
---
kind: CacheRedis.Store
metadata: { name: Store }
url: !cel "secrets.redisUrl"
fallback: !ref Local
```

Pulling Redis down logs a `cache.degraded` event and serves from `Local` until Redis returns.
