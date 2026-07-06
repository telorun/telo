---
"@telorun/sse-codec": minor
---

`Sse.Encoder` now supports resumable streams. An optional `id` field on a record becomes the SSE `id:` line (the `Last-Event-ID` reconnection cursor), and a missing `type` defaults the event to `message` instead of erroring — so a typeless `{ id, data }` replay-journal envelope frames directly (`id: <id>\nevent: message\ndata: <json>`) with no bespoke shaping. Typed records without an `id` are unchanged (backward compatible). A non-string `type` is still rejected.
