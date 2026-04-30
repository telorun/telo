---
description: "Ai.OpenaiModel: OpenAI provider for Ai.Model. Implements both invoke (generateText) and stream (streamText) via Vercel AI SDK. Schema, options, redaction."
sidebar_label: Ai.OpenaiModel
---

# `Ai.OpenaiModel`

> Examples below assume this module is imported with `Telo.Import` alias `AiOpenai` (and `ai` as `Ai`). Kind references (`AiOpenai.OpenaiModel`, `Ai.Text`, `Ai.TextStream`, …) follow those aliases — if you import either module under a different name, substitute accordingly.

OpenAI provider for the `Ai.Model` abstract. Implements the full `AiModelInstance` runtime contract via Vercel AI SDK (`ai` + `@ai-sdk/openai`). Available as a peer-installable package — users who don't talk to OpenAI don't pay for the SDK weight.

```yaml
kind: Telo.Import
metadata: { name: AiOpenai }
source: ../modules/ai-openai
---
kind: AiOpenai.OpenaiModel
metadata: { name: Gpt4o }
model: gpt-4o
apiKey: "${{ secrets.OPENAI_API_KEY }}"
options:
  temperature: 0.2
  maxOutputTokens: 800
```

The resource is then referenced from any `Ai.Model` consumer:

```yaml
kind: Ai.Text
metadata: { name: Summarizer }
model:
  kind: AiOpenai.OpenaiModel
  name: Gpt4o
```

---

## Schema

| Field     | Type   | Required | Description                                                                                                       |
| --------- | ------ | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `model`   | string | yes      | OpenAI model identifier (e.g. `gpt-4o`, `gpt-4o-mini`, `o1-preview`).                                             |
| `apiKey`  | string | yes      | API key. Use a secret reference: `"${{ secrets.OPENAI_API_KEY }}"`. Compile-evaluated, never appears at runtime CEL. |
| `baseUrl` | string | no       | Override the OpenAI API base URL — useful for Azure OpenAI and OpenAI-compatible gateways.                        |
| `options` | object | no       | Model-level defaults (temperature, maxOutputTokens, topP, frequencyPenalty, …). Merged beneath the caller's options. |

`apiKey` and `baseUrl` are `x-telo-eval: compile`, so they resolve at load time from `secrets.*` / `env.*`. Hardcoded keys in manifests work but are strongly discouraged.

## Invoke / stream

Both methods delegate to Vercel AI SDK:

- `invoke({messages, options})` → `generateText({...})` → `{text, usage, finishReason}`.
- `stream({messages, options})` → `streamText({...})` → `AsyncIterable<StreamPart>`.

Vercel's finish reasons map straight into the Ai contract:

| Vercel reason     | Ai.Model `finishReason` |
| ----------------- | ----------------------- |
| `stop`            | `stop`                  |
| `length`          | `length`                |
| `content-filter`  | `content-filter`        |
| `tool-calls`      | `other`                 |
| `error`           | `error`                 |
| anything else     | `other`                 |

`tool-calls` maps to `other` because neither `Ai.Text` nor `Ai.TextStream` exposes tool choices — when (and if) `Ai.Agent` lands, that surface gets dedicated handling.

## Options

Pass anything Vercel's `generateText` / `streamText` accepts. Common keys:

- `temperature: number`
- `maxOutputTokens: number`
- `topP: number`
- `frequencyPenalty: number`
- `presencePenalty: number`
- `seed: number`
- `stopSequences: string[]`

Provider-specific extensions (e.g. `providerOptions: { openai: { … } }`) flow through unchanged.

## Snapshot redaction

`apiKey` is omitted from the CEL-visible snapshot. Other fields (model id, baseUrl, options) remain visible — useful for telemetry and debugging:

```yaml
inputs:
  modelName: "${{ resources.Gpt4o.model }}"  # works
  apiKey: "${{ resources.Gpt4o.apiKey }}"    # always null
```

## Errors

Vendor errors bubble through unchanged — rate limits, authentication failures, malformed prompts, etc. surface with their original messages. No retry, no swallowing. Wrap in `try` / `catch` inside `Run.Sequence` if you want to handle them.

For streaming calls, mid-stream failures from the provider are translated into a `StreamPart` of shape `{ type: "error", error: { message, code?, data? } }` and yielded as the terminator — generic encoders (`Ndjson.Encoder`, `Sse.Encoder`) frame this as an in-band error record without a bespoke serialization step. The native `Error` instance never reaches the wire (it isn't JSON-serializable). Already-emitted text-delta parts are preserved; consumers see partial output plus a structured error record.

## Azure OpenAI / OpenAI-compatible gateways

Set `baseUrl` to override the endpoint:

```yaml
kind: AiOpenai.OpenaiModel
metadata: { name: AzureGpt4 }
model: gpt-4
apiKey: "${{ secrets.AZURE_OPENAI_KEY }}"
baseUrl: "https://my-resource.openai.azure.com/openai/deployments/gpt-4"
```
