---
"@telorun/run": minor
---

Add three declarative control-flow kinds to `std/run`, each a thin binding wrapper over `Run.Sequence`'s `steps` body (sharing the step engine, now extracted into `engine.ts`):

- **`Run.Loop`** (`Telo.Runnable`) — repeats its `steps` body while `condition` holds and/or until `maxIterations`. Adds `iteration` (count) and `previous` (prior iteration's step map, null on the first) to the body scope, enabling poll-until-ready.
- **`Run.Iteration`** (`Telo.Runnable`) — runs the body once per element of `collection`, for side-effects, with `item`/`index`/`items` in scope and a `concurrency` bound (default 1 = ordered).
- **`Run.Projection`** (`Telo.Invocable`) — same per-element binding, collecting each element's `outputs` into an array in input order, with `concurrency`.

The bodies reuse the full `Run.Sequence` step grammar minus the inline `while` block (the kinds are themselves the loop); `while` stays in `Run.Sequence`. All three accept a kind-level `catches` list (the repo's house-style error contract) that maps a throw escaping the whole operation to a fallback result — fail-fast by default, with per-element recovery via inline `try/catch` in the body.
