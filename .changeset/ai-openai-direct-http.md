---
"@telorun/ai-openai": minor
---

Reimplement the OpenAI provider against the `/chat/completions` HTTP API directly, dropping the Vercel AI SDK (`ai` + `@ai-sdk/openai`) and its transitive `zod` peer dependency. The same controller now serves OpenAI and every OpenAI-compatible endpoint (Azure OpenAI, Ollama, vLLM, Groq, Together, OpenRouter, …) via `baseUrl`, and it carries no JS-only SDK weight — closer to Telo's polyglot-controller goal. `invoke` and `stream` keep the same `Ai.Model` contract (buffered result, SSE `text-delta`/`finish`/`error` parts, `tool-calls`, secret redaction).

Breaking for manifests that set `options`: keys are camelCase OpenAI request params, normalized to snake_case on the wire (e.g. `maxTokens` instead of the SDK's `maxOutputTokens`; `topP`, `frequencyPenalty`, …). Nested values and already-snake_case keys pass through unchanged.
