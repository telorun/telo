---
"@telorun/lease": minor
---

New `lease` module: `Lease.Critical`, a declarative critical section over a `Cache.Store`. It wraps a body and owns the whole acquire → run → release lifecycle (like `Cache.View` wraps caching), so manifests never issue imperative acquire/release calls. At most one holder per `key`; a second attempt reports the current `holder` instead of running the body (branch on `acquired` — skip, or return 409). Leases are time-bounded (`ttl`, self-healing on holder death) and race-free via `Cache.Store.increment`. Two modes: synchronous (release on body return — cron overlap, migrations, singleflight) and `detach: true` (dispatch the body detached, hold the lease across it, release on its terminal — "one background operation per key," e.g. a per-conversation agent turn).
