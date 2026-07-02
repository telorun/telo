---
"@telorun/ai": minor
---

Add `Ai.AgentStream` — the streaming counterpart of `Ai.Agent`. Runs the same tool-use loop but emits a `Stream` of `AgentStreamPart` events (`text-delta` | `tool-call` | `tool-result` | `finish` | `error`) on `result.output`, so assistant text streams token-by-token and every tool call surfaces live. Pipe it through an encoder in an `Http.Api` `mode: stream` route for SSE. The `StreamPart` union gains an additive `tool-call` variant; tool assembly and dispatch are shared with `Ai.Agent` so the two agents cannot drift.
