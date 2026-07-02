---
description: "Ai.OpenaiModel: OpenAI-compatible provider for Ai.Model. Implements invoke and stream against the OpenAI /chat/completions HTTP API directly (no vendor SDK). Schema, options, redaction."
sidebar_label: Ai.OpenaiModel
---

# `Ai.OpenaiModel`

> Examples below assume this module is imported with an `imports:` entry under alias `AiOpenai` (and `ai` as `Ai`). Kind references (`AiOpenai.OpenaiModel`, `Ai.Text`, `Ai.TextStream`, …) follow those aliases — if you import either module under a different name, substitute accordingly.

OpenAI-compatible provider for the `Ai.Model` abstract. A **`Telo.Provider`** — a configured model client referenced by `Ai.Text` / `Ai.TextStream` / `Ai.Agent`, never invoked directly as a target or step. Implements the full `AiModelInstance` runtime contract (`invoke` + `stream`) by calling the OpenAI `POST /chat/completions` HTTP API **directly** — no vendor SDK, no `zod`, nothing beyond `@telorun/ai`. Because the wire protocol is the de-facto standard, the same controller serves OpenAI and every OpenAI-compatible endpoint (Azure OpenAI, Ollama, vLLM, Groq, Together, OpenRouter, …) via `baseUrl`.

```yaml
kind: Telo.Application
metadata: { name: summarizer, version: 1.0.0 }
imports:
  AiOpenai: std/ai-openai@<version>
---
kind: AiOpenai.OpenaiModel
metadata: { name: Gpt4o }
model: gpt-4o
apiKey: "${{ secrets.OPENAI_API_KEY }}"
options:
  temperature: 0.2
  maxTokens: 800
```

The resource is then referenced from any `Ai.Model` consumer:

```yaml
kind: Ai.Text
metadata: { name: Summarizer }
model: !ref Gpt4o
```

---

## Schema

| Field     | Type   | Required | Description                                                                                                       |
| --------- | ------ | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `model`   | string | yes      | Model identifier (e.g. `gpt-4o`, `gpt-4o-mini`, `o1-preview`).                                                    |
| `apiKey`  | string | yes      | API key, sent as `Authorization: Bearer …`. Use a secret reference: `"${{ secrets.OPENAI_API_KEY }}"`. Compile-evaluated, never appears at runtime CEL. |
| `baseUrl` | string | no       | Override the API base URL (default `https://api.openai.com/v1`). `/chat/completions` is appended. Useful for Azure OpenAI and OpenAI-compatible gateways. |
| `options` | object | no       | camelCase OpenAI request params, normalized to snake_case and merged into the request body. Merged beneath the caller's options. |

`apiKey` and `baseUrl` are `x-telo-eval: compile`, so they resolve at load time from `secrets.*` / `env.*`. Hardcoded keys in manifests work but are strongly discouraged.

## Invoke / stream

Both methods call `POST {baseUrl}/chat/completions` directly:

- `invoke({messages, options, tools?})` → buffered request → `{text, usage, finishReason, toolCalls?}`.
- `stream({messages, options, tools?})` → `stream: true` request, parsed from the SSE `data:` frames → `AsyncIterable<StreamPart>`. `stream_options.include_usage` is set so the terminal `finish` part carries token usage.

OpenAI `finish_reason` values map into the Ai contract:

| OpenAI `finish_reason` | Ai.Model `finishReason` |
| ---------------------- | ----------------------- |
| `stop`                 | `stop`                  |
| `length`               | `length`                |
| `tool_calls`           | `tool-calls`            |
| `function_call`        | `tool-calls`            |
| `content_filter`       | `content-filter`        |
| anything else / absent | `other`                 |

`tool-calls` is preserved (not flattened to `other`): `Ai.Agent` drives the tool-use loop on it — when the model requests tools, the returned `toolCalls` are executed and replayed. `Ai.Text` / `Ai.TextStream` never pass `tools`, so they never see this reason.

Tool calls are advertised as OpenAI `tools: [{ type: "function", function: { name, description, parameters } }]` (no `execute` — the agent runs tools itself). The model's `tool_calls` come back with `arguments` as a JSON string; the provider parses each into the `ToolCall.arguments` object. Malformed argument JSON surfaces as an error rather than a silent empty object.

On the **streaming** path, OpenAI splits each tool call across many `delta.tool_calls[]` fragments keyed by `index` — the first carries `id` and `function.name`, later ones append `function.arguments` string fragments. The provider accumulates per index and, at the finish boundary (arguments are only valid JSON once fully joined), emits one `{ type: "tool-call", toolCall }` `StreamPart` per assembled call before the terminal `finish`. This is what lets [`Ai.AgentStream`](../../ai/docs/ai-agent-stream.md) drive a tool-use loop with live token streaming; `Ai.TextStream` never passes `tools`, so it never observes these parts.

## Multimodal content

Message `content` may be a string or [content parts](../../ai/docs/ai-model.md) (text + image). The provider translates them into OpenAI's wire shapes:

- A **user** message with parts becomes an OpenAI content array — text parts → `{ type: "text", text }`, image parts → `{ type: "image_url", image_url: { url } }`, where `url` is a `data:<mediaType>;base64,…` URL built from the part's bytes (or its base64 string). **System** messages can't carry images, so any parts are flattened to their text.
- A **tool** message can't carry images in OpenAI chat completions. When a tool answered with an image, the provider emits the `tool` message with a short text placeholder (its text parts, if any) and then a **synthetic follow-up `user` message** holding the image parts — the documented OpenAI pattern. The Ai contract stays provider-neutral; only this translation differs (an image-native provider would map the same parts into its own tool-result blocks).

## Options

`options` use **camelCase** (the Telo manifest convention). Each top-level key is normalized to the OpenAI snake_case wire parameter before the request is sent (`maxTokens` → `max_tokens`, `topP` → `top_p`):

- `temperature: number`
- `maxTokens: number` (or `maxCompletionTokens` for reasoning models like `o1`/`o3`)
- `topP: number`
- `frequencyPenalty: number`
- `presencePenalty: number`
- `seed: number`
- `stop: string | string[]`

Any other field OpenAI (or your compatible gateway) accepts flows through — `responseFormat`, `logitBias`, provider-specific extensions, etc. Only top-level keys are converted; nested object values (a `responseFormat` JSON schema, a `logitBias` token map) keep their own casing. Keys already written in snake_case are passed through unchanged.

## Snapshot redaction

`apiKey` is omitted from the CEL-visible snapshot. Other fields (model id, baseUrl, options) remain visible — useful for telemetry and debugging:

```yaml
inputs:
  modelName: "${{ resources.Gpt4o.model }}"  # works
  apiKey: "${{ resources.Gpt4o.apiKey }}"    # always null
```

## Errors

A non-2xx response from `invoke` throws an actionable error built from the provider's `{ error: { message } }` body (falling back to the raw response text), prefixed with the HTTP status. No retry, no swallowing. Wrap in `try` / `catch` inside `Run.Sequence` if you want to handle them.

For streaming calls, a non-OK response or a mid-stream failure is translated into a `StreamPart` of shape `{ type: "error", error: { message, code?, data? } }` and yielded as the terminator — generic encoders (`Ndjson.Encoder`, `Sse.Encoder`) frame this as an in-band error record without a bespoke serialization step. The native `Error` instance never reaches the wire (it isn't JSON-serializable). Already-emitted text-delta parts are preserved; consumers see partial output plus a structured error record.

## Azure OpenAI / OpenAI-compatible gateways

Set `baseUrl` to override the endpoint (the controller appends `/chat/completions`):

```yaml
kind: AiOpenai.OpenaiModel
metadata: { name: LocalLlama }
model: llama3.1
apiKey: "${{ secrets.OPENAI_API_KEY }}"   # ignored by servers that don't require auth
baseUrl: "http://localhost:11434/v1"      # Ollama, vLLM, LM Studio, …
```
