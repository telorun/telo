---
"@telorun/cache": minor
"@telorun/cache-memory": minor
"@telorun/cache-redis": minor
---

Add `increment(key, delta, ttlMs)` to the `Cache.Store` contract — a race-free atomic counter that returns the new total, starts a missing key at 0, and sets its `ttlMs` expiry only when the counter is first created this window (fixed window; later increments don't extend it). The memory backend is atomic within the event loop; the Redis backend uses an `INCRBY` + conditional `PEXPIRE` Lua script. This backs correct reserve/settle counters (spend budgets, quotas, metrics) that a `get`-then-`set` read-modify-write could not do without racing. `isCacheStore` now also checks for `increment`, so any external `CacheStore` implementation must add it.
