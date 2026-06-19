# Cache

The backend-pluggable cache abstract for Telo. `Cache.Store` is the contract every backend implements; `Cache.Lookup`, `Cache.Entry`, and `Cache.View` operate against any store. Backends ship as their own modules — `cache-memory` (`CacheMemory.Store`) and `cache-redis` (`CacheRedis.Store`) — mirroring the `codec` / `*-codec` family.

## Why use this

- **Backend-pluggable** — write `!ref` to a `Cache.Store`; swap memory ↔ Redis without touching consumers.
- **Freshness-aware** — entries carry a fresh window (`ttl`) and an optional stale grace window (`staleTtl`); a lookup reports `fresh`, `stale`, or `miss`.
- **Read-through decorator** — `Cache.View` wraps any invocable and serves it from cache, with stale-while-revalidate (background or synchronous) and stale-if-error.

## Kinds

| Kind | Capability | Purpose |
| --- | --- | --- |
| `Cache.Store` | Provider (abstract) | The backing store contract; satisfied by a concrete backend. |
| `Cache.Lookup` | Invocable | Read a key → `{ state, value, age }`. |
| `Cache.Entry` | Invocable | Write a key with the configured `ttl` / `staleTtl`. |
| `Cache.View` | Invocable | Read-through decorator over a wrapped `invoke:` target. |

`Cache.Lookup` / `Cache.View` result `state`:

- `fresh` — within the fresh window (`ttl`).
- `stale` — past `ttl` but within `staleTtl`.
- `miss` — absent or expired past the stale window.

## Cache.View — read-through

`Cache.View` is a decorator: it dispatches its wrapped target through the standard `invoke:` field and serves the result from `store`. On a stale hit its `revalidate` mode decides behaviour:

- `background` — serve stale immediately, refresh detached (single-flight per key); the kernel drains in-flight refreshes when the resource tears down.
- `sync` — reload before returning; on loader error keep serving stale (stale-if-error).
- `off` — treat stale as a miss.

## Example

```yaml
imports:
  Cache: std/cache@latest
  CacheMemory: std/cache-memory@latest
---
kind: CacheMemory.Store
metadata: { name: Store }
---
kind: Cache.View
metadata: { name: UserView }
store: !ref Store
invoke: !ref LoadUser      # any Telo.Invocable (e.g. a SQL lookup)
ttl: "300s"
staleTtl: "3600s"
revalidate: background
```

Invoke `UserView` with `{ key: "<cache key>", ... }`; all inputs are forwarded to the wrapped target on a miss or revalidation.
