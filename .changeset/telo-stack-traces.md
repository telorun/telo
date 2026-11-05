---
"@telorun/sdk": minor
"@telorun/kernel": minor
"@telorun/cli": minor
---

A failure written to a log from the Node runtime carries a Telo stack trace instead of the JavaScript stack. The record's `error` gains `frames` (the resources and manifest positions the failure passed through, innermost first, bounded at 64 with `dropped_frames_count` counting the cut) and its `stack` is those frames as text with files relative to the entry module's directory; `pretty` shows the same lines with files relative to the working directory. A host stack is written as `host_stack` only for an uncoded failure (a `TypeError`, a library's exception, `ERR_FATAL`), on the entry that is one. The step engine and the boot runner state where each call is made (`calledAt` on the dispatch context), a `throw` step starts a fresh trace whose `cause` keeps the caught failure's frames, and `telo: failed to start` prints the Telo trace. The SDK exports the frame type, `errorValueOf` and the trace helpers; frames never reach a catch context, a durable record or a trace payload.
