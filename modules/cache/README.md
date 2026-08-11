# Cache

The backend-pluggable cache abstract for Telo. `Cache.Store` is the contract every backend implements; `Cache.Lookup`, `Cache.Entry`, and `Cache.View` operate against any store. Backends ship as their own modules — `cache-memory` (`CacheMemory.Store`) and `cache-redis` (`CacheRedis.Store`) — mirroring the `codec` / `*-codec` family.

## Why use this

- **Backend-pluggable** — write `!ref` to a `Cache.Store`; swap memory ↔ Redis without touching consumers.
- **Freshness-aware** — entries carry a fresh window (`ttl`) and an optional stale grace window (`staleTtl`); a lookup reports `fresh`, `stale`, or `miss`.
- **Read-through decorator** — `Cache.View` wraps any invocable and serves it from cache, with stale-while-revalidate (background or synchronous) and stale-if-error.
- **Atomic counters** — the store contract includes `increment(key, delta, ttlMs)`, a race-free counter with a fixed window (expiry set only when first created). It backs correct reserve/settle budgets (`RateLimit.Budget`), quotas, and metrics where a `get`-then-`set` read-modify-write would race.

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

A failed revalidation is logged at `warn` with the cache key and the underlying error, in both the `background` and `sync` modes. The caller cannot see it — stale-if-error is a successful response by design — so the log record is the only signal that the wrapped target is failing while the cache masks it.

Every lookup also logs its outcome at `debug` (`served from cache`, `served stale, revalidating in the background`, `revalidated before returning`, `called through`), carrying `cache.key` and, where known, `cache.age`. Raise the module's import to `level: debug` to see hit/miss behaviour; the action is not recoverable from the returned state, since a `stale` result may or may not have triggered a revalidation and `revalidate: off` reports a stale entry to the caller as a `miss`.

## Example

```yaml
imports:
  Cache: oci://ghcr.io/telorun/cache@0.5.0
  CacheMemory: oci://ghcr.io/telorun/cache-memory@0.5.0
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
