# AI OpenAI

OpenAI provider for the `Ai.Model` abstract from `@telorun/ai`, backed by the Vercel AI SDK.

## Why use this

- **Drop-in `Ai.Model`** — works with `Ai.Text`, `Ai.TextStream`, or any consumer that takes an `Ai.Model` reference.
- **Buffered and streaming** — implements both the `invoke` path and the `stream` path via `@ai-sdk/openai`.
- **OpenAI-compatible endpoints** — `baseUrl` opt-in for Azure OpenAI, gateways, and self-hosted OpenAI-compatible servers.
- **Option layering** — model-level defaults are shallow-merged with per-call options; downstream wins.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Ai.OpenaiModel` | OpenAI implementation of `Ai.Model`. Pass to any `Ai.Model` consumer. |

## Example

```yaml
kind: Telo.Application
metadata: { name: example, version: 1.0.0 }
secrets:
  openaiApiKey:
    env: OPENAI_API_KEY
    type: string
---
kind: Telo.Import
metadata: { name: Ai }
source: pkg:npm/@telorun/ai@^1.0.0
---
kind: Telo.Import
metadata: { name: AiOpenai }
source: pkg:npm/@telorun/ai-openai@^1.0.0
---
kind: AiOpenai.OpenaiModel
metadata: { name: Gpt4oMini }
model: gpt-4o-mini
apiKey: "${{ secrets.openaiApiKey }}"
options:
  temperature: 0.2
  maxOutputTokens: 800
---
kind: Ai.Text
metadata: { name: Summarizer }
model:
  kind: AiOpenai.OpenaiModel
  name: Gpt4oMini
```

## Reference

- [`Ai.OpenaiModel`](docs/ai-openai-model.md) — schema, options, redaction, Azure setup, Vercel finish-reason mapping.
