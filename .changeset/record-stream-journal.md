---
"@telorun/record-stream": minor
---

Add the `RecordStream.Journal` family — an in-memory, keyed, offset-addressable replay buffer that makes a **detached** stream **resumable**. `RecordStream.Journal` (Provider) is the buffer store (monotonic 1-based ids per key); `RecordStream.JournalSink` (`{ key, input }`) drains a stream into it, finishing the key on completion or failing it on error (recording the error for readers, then rethrowing — never swallowed); `RecordStream.JournalSource` (`{ key, fromId? }` → `{ output }` of `{ id, data }`) replays entries past `fromId` and then tails live until the key completes. Together they back a resumable transport (start work detached under a `turnId`, hand the client that id, let it reconnect via an SSE `Last-Event-ID`) that `OnComplete`/`Tee` — which observe a single live consumption — cannot.
