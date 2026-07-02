---
"@telorun/ai-openai": minor
---

Surface tool calls on the streaming path. `stream()` now accumulates OpenAI's incremental `delta.tool_calls[]` fragments and emits one assembled `tool-call` `StreamPart` per call before the terminal `finish`, so `Ai.AgentStream` can drive a tool-use loop with live token streaming. Text-only streaming (`Ai.TextStream`) is unaffected.
