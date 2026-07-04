---
"@telorun/record-stream": minor
---

Add `RecordStream.OnComplete` — a stream passthrough that fires a `handler` Invocable once, after the input completes, with `{ records, context }` (the full list of items observed plus opaque caller data). Forwards every item live to `output`; the handler is skipped on input error or early cancellation. Closes the persist-while-streaming loop (stream an AI/agent response to a client while persisting the turn at end-of-stream) that a bare `Tee` can't, since its second branch has no autonomous driver inside a stream handler.
