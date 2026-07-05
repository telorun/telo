---
"@telorun/stream": minor
---

Add `Stream.Collect` — a terminal stream sink, the inverse of `Stream.Of`. Consumes a `Stream` to completion and returns every item as `items` (an array), in order. Draining drives the producer's side effects (so it runs an upstream `Ai.AgentStream` turn or pipeline) and materializes the finite stream so a caller can inspect, assert, or aggregate it in CEL — replacing a hand-rolled `JS.Script` drain. Buffered, bounded by the stream's length.
