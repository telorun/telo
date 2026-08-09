# AI OpenAI

OpenAI-compatible provider for the `Ai.Model` and `Ai.ImageModel` abstracts from `@telorun/ai`. Calls the OpenAI `/chat/completions` and images HTTP APIs directly — no vendor SDK.

## Why use this

- **Drop-in `Ai.Model`** — works with `Ai.Text`, `Ai.TextStream`, or any consumer that takes an `Ai.Model` reference.
- **Buffered and streaming** — implements both the `invoke` path and the SSE `stream` path.
- **Images too** — `AiOpenai.OpenaiImageModel` serves `Ai.Image` for generation, editing, inpainting and variations, on the same key and base URL.
- **No SDK weight** — direct HTTP, no `ai` / `@ai-sdk/openai` / `zod`; only depends on `@telorun/ai`.
- **OpenAI-compatible endpoints** — `baseUrl` opt-in for Azure OpenAI, gateways, and self-hosted OpenAI-compatible servers (Ollama, vLLM, Groq, …).
- **Option layering** — model-level defaults are shallow-merged with per-call options; downstream wins.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Ai.OpenaiModel` | OpenAI implementation of `Ai.Model`. Pass to any `Ai.Model` consumer. |
| `AiOpenai.OpenaiImageModel` | OpenAI implementation of `Ai.ImageModel`. Pass to `Ai.Image`. |

## Example

```yaml
kind: Telo.Application
metadata: { name: example, version: 1.0.0 }
imports:
  Ai: oci://ghcr.io/telorun/ai@0.10.0
  AiOpenai: oci://ghcr.io/telorun/ai-openai@0.12.0
secrets:
  openaiApiKey:
    env: OPENAI_API_KEY
    type: string
---
kind: AiOpenai.OpenaiModel
metadata: { name: Gpt4oMini }
model: gpt-4o-mini
apiKey: !cel "secrets.openaiApiKey"
options:
  temperature: 0.2
  maxTokens: 800
---
kind: Ai.Text
metadata: { name: Summarizer }
model: !ref Gpt4oMini
```

## Reference

- [`Ai.OpenaiModel`](docs/ai-openai-model.md) — schema, options, redaction, Azure / compatible-gateway setup, finish-reason mapping.
- [`AiOpenai.OpenaiImageModel`](docs/ai-openai-image-model.md) — schema, endpoint routing per intent, response format, dimensions, usage, refusals.
