---
"@telorun/record-stream": minor
---

Add `RecordStream.Tee` — fan one input stream out to two consumers. Each output sees every item from the source. Source pulls are serialized by an internal lock; items are buffered for the lagging consumer (bounded by source-stream length). Source errors propagate to both outputs on their next pull. Pairs with the chat-console example's "print + capture" pattern (`Ai.TextStream → Tee → [ExtractText → WriteStream | history-collector]`).
