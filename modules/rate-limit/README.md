# Rate Limit

`RateLimit.Guard` — a transport-neutral sliding-window rate limiter. Counters live in any [`Cache.Store`](../cache/README.md), so the limiter composes with whichever backend is wired (`cache-memory` for a single instance, `cache-redis` for shared limits).

## Why use this

- **Transport-neutral** — the `key` is an explicit input (a client IP, API key, user, tenant); the guard doesn't know about HTTP.
- **Non-throwing** — returns a verdict `{ allowed, remaining, retryAfter }`; the caller maps the response (e.g. a `429`).
- **Composable storage** — counters share the same `Cache.Store` seam as the rest of the app; point it at `cache-redis` for limits shared across instances.
- **Fails closed** — an empty key is denied, never collapsed into one shared bucket.

## Kinds

| Kind | Capability | Purpose |
| --- | --- | --- |
| `RateLimit.Guard` | Invocable | Sliding-window check for a `key`; returns a verdict. |

## Example

```yaml
imports:
  Cache: std/cache@latest
  CacheMemory: std/cache-memory@latest
  RateLimit: std/rate-limit@latest
---
kind: CacheMemory.Store
metadata: { name: Counters }
---
kind: RateLimit.Guard
metadata: { name: PublicLimit }
store: !ref Counters
limit: 60
window: "60s"
```

Invoke with `{ key: "<client id>" }`. On an HTTP route, feed `${{ request.ip }}` (see `Http.Server.trustProxy`) and map `allowed: false` to a `429` with `Retry-After: ${{ string(result.retryAfter) }}`.
