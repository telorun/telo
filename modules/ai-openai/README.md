---
description: "@telorun/ai-openai — OpenAI provider for Ai.Model. Implements both invoke (generateText) and stream (streamText) via Vercel AI SDK."
---

# Telo Ai.OpenaiModel

OpenAI provider for the `Ai.Model` abstract from `@telorun/ai`. Implements both the buffered `invoke` path (used by `Ai.Text`) and the streaming `stream` path (used by `Ai.TextStream`) via the Vercel AI SDK.

## Install

```bash
pnpm add @telorun/ai-openai
```

Pulls in `ai` + `@ai-sdk/openai` as dependencies. `@telorun/ai` is also required (peer-style — install it explicitly if not already present).

## Usage

```yaml
kind: Telo.Application
metadata: { name: example, version: 1.0.0 }
secrets:
  OPENAI_API_KEY: { type: string }
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
apiKey: "${{ secrets.OPENAI_API_KEY }}"
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

See [docs/ai-openai-model.md](./docs/ai-openai-model.md) for schema, options, redaction, Azure setup, and the Vercel finish-reason mapping.

The contract that makes this provider drop-in compatible with any `Ai.Model` consumer (including third-party kinds) is documented at [`@telorun/ai`'s docs/ai-model.md](../ai/docs/ai-model.md).
