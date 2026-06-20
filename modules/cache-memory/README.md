# Cache Memory

`CacheMemory.Store` — an in-process implementation of the [`Cache.Store`](../cache/README.md) abstract. Zero external dependencies; ideal for single-instance deployments, tests, and as the `fallback` behind `CacheRedis.Store`.

## Why use this

- **Zero setup** — entries live in a `Map` in the process; nothing to run.
- **Freshness-aware** — honours the fresh (`ttl`) and stale (`staleTtl`) windows written by `Cache.Entry` / `Cache.View`.
- **Bounded** — `maxEntries` caps memory; the oldest-written entry is evicted (FIFO) on overflow.

## Kinds

| Kind | Capability | Purpose |
| --- | --- | --- |
| `CacheMemory.Store` | Provider | In-process cache store; satisfies `Cache.Store`. |

## Example

```yaml
imports:
  Cache: std/cache@latest
  CacheMemory: std/cache-memory@latest
---
kind: CacheMemory.Store
metadata: { name: Store }
maxEntries: 10000
---
kind: Cache.Entry
metadata: { name: Put }
store: !ref Store
ttl: "60s"
---
kind: Cache.Lookup
metadata: { name: Get }
store: !ref Store
```
