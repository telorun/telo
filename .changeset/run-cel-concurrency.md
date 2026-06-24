---
"@telorun/run": patch
---

Fix `Run.Projection` and `Run.Iteration` silently producing `[null, …]` (or running every element sequentially) when `concurrency` is a `!cel` expression. The field was read raw and handed to the scheduler as an unevaluated `CompiledValue`, so `Math.floor(...)` yielded `NaN`, zeroed the worker pool, and returned a sparse array. `concurrency` is now resolved via `expandValue` and validated to a positive integer (mirroring `Run.Loop`'s `maxIterations`); a value that does not resolve to an integer ≥ 1 raises `INVALID_CONCURRENCY` instead of failing silently. `mapConcurrent` also now rejects a non-finite concurrency as defence in depth.
