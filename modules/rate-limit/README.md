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
| `RateLimit.Budget` | Invocable | Windowed **weighted** spend budget; two-phase reserve/settle. |

## `RateLimit.Budget` — weighted spend

Where `Guard` counts requests (+1 each), `Budget` debits an arbitrary **cost**,
so it bounds token spend, bytes, or any metered resource. It is two-phase so the
counter can't be gamed:

- **`reserve`** — `{ op: reserve, key, amount }` atomically debits a worst-case
  `amount` up front. If that pushes the window total over `limit` it refunds and
  denies (`{ allowed: false, retryAfter }`); otherwise returns
  `{ allowed: true, remaining, reserved }`. The atomic debit closes the
  concurrent-burst race (simultaneous first-calls can't all read under-ceiling
  and proceed), and charging up front means a reserve-then-abandon still pays.
- **`settle`** — `{ op: settle, key, amount, reserved }` adjusts the reservation
  to the **actual** cost (`amount`), refunding `reserved − amount`. Call it on
  every terminal path; report `amount == reserved` to keep the full reservation
  when a unit of work failed with no measurable cost.

`limit` is the max total cost per key per `window`. The backend must expose an
atomic counter (`Cache.Store.increment`) — both bundled stores do; it is a
**fixed window** (resets `window` after the first debit), the honest generic
guarantee over a plain key/value store.

```yaml
kind: RateLimit.Budget
metadata: { name: SpendCap }
store: !ref Counters      # a CacheRedis.Store bounds spend across instances
limit: 2000000            # e.g. tokens per window
window: "1h"
```

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
