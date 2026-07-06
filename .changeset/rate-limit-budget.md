---
"@telorun/rate-limit": minor
---

Add `RateLimit.Budget` — a windowed, **weighted** spend budget over a `Cache.Store`, complementing the request-counting `Guard`. Both kinds' `limit` / `window` config fields are now compile-time CEL slots (`x-telo-eval: compile`), so they can be driven from `variables` / env (operator-tuned ceilings). It debits an arbitrary cost (tokens, bytes, any metered resource) in two phases: `reserve` atomically debits a worst-case `amount` up front (refunding + denying if it would exceed `limit`), and `settle` adjusts the reservation to the actual cost, refunding `reserved − amount`. The atomic debit (via the new `Cache.Store.increment`) closes the concurrent-burst race and charge-on-start closes the reserve-then-abandon leak, so `limit` is a hard per-window bound. Fixed window; fails closed on an empty key.
