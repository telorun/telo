---
description: "OpenAI.ChatModel and OpenAI.ChatModelStream: OpenAI-compatible chat providers, buffered and streaming, over the /chat/completions HTTP API directly (no vendor SDK). Schema, options, redaction."
sidebar_label: OpenAI.ChatModel
---

# `OpenAI.ChatModel`

> Examples below assume this module is imported with an `imports:` entry under alias `OpenAI` (and `ai` as `Ai`). Kind references (`OpenAI.ChatModel`, `Ai.Text`, `Ai.TextStream`, …) follow those aliases — if you import either module under a different name, substitute accordingly.

OpenAI-compatible provider for the model abstracts, as **two kinds**: `OpenAI.ChatModel` implements `Ai.Model` (buffered) and `OpenAI.ChatModelStream` implements `Ai.ModelStream`. Both are `Telo.Invocable` with one declared, kernel-bound `invoke`, and they share their request translation so it cannot drift between them. They call the OpenAI `POST /chat/completions` HTTP API **directly** — no vendor SDK, no `zod`, nothing beyond `@telorun/ai`. Because the wire protocol is the de-facto standard, the same controller serves OpenAI and every OpenAI-compatible endpoint (Azure OpenAI, Ollama, vLLM, Groq, Together, OpenRouter, …) via the client's `baseUrl`.

For reasoning — especially reasoning with tools — use [`OpenAI.ResponsesModel`](./responses-model.md) instead: `/chat/completions` refuses a non-`none` reasoning effort alongside function tools.

The account is a plain `Http.Client`, so the key and the base URL are declared once for every OpenAI kind in the app and the 401 re-acquire-and-retry is inherited rather than re-implemented here.

```yaml
kind: Http.BearerToken
metadata: { name: openaiKey }
token: !cel "secrets.openaiApiKey"
---
kind: Http.Client
metadata: { name: openaiClient }
baseUrl: https://api.openai.com/v1
credential: !ref openaiKey
---
kind: Http.Request
metadata: { name: openaiRequest }
client: !ref openaiClient
---
kind: OpenAI.ChatModel
metadata: { name: gpt4o }
model: gpt-4o
request: !ref openaiRequest
options:
  temperature: 0.2
  maxTokens: 800
```

The resource is then referenced from any `Ai.Model` consumer:

```yaml
kind: Ai.Text
metadata: { name: summarizer }
model: !ref gpt4o
```

---

## Schema

| Field     | Type   | Required | Description |
| --------- | ------ | -------- | ----------- |
| `model`   | string | yes      | Model identifier (e.g. `gpt-4o`, `gpt-4o-mini`). |
| `request` | ref    | yes      | The `Http.Request` every call goes through. Its client carries the base URL and the credential. |
| `options` | object | no       | camelCase OpenAI request params, normalized to snake_case and merged into the request body. Merged beneath the caller's options. |

`model` and `options` are `x-telo-eval: compile`, so they resolve at load time from `variables.*` / `secrets.*`.

There is no `apiKey` and no `baseUrl`: both belong to the account. Point `request` at a client whose `baseUrl` is the endpoint and whose `credential` carries the key — one declaration serves every OpenAI kind in the app.

## Invoke / stream

Both kinds POST to `/chat/completions` through the injected request. Each has one declared, kernel-bound `invoke`:

- `OpenAI.ChatModel.invoke({messages, options, tools?, responseFormat?})` → a buffered request → `{content, text, usage, finishReason, toolCalls?}`. `responseFormat` is sent as `response_format`, and a `json_schema` format is normalized into this API's nested `{type, json_schema: {…}}` form — the responses kinds take the same contract value flat under `text.format`, and each API refuses the other's shape, so both kinds reshape rather than pass through.
- `OpenAI.ChatModelStream.invoke({messages, options, tools?})` → a `stream: true` request, parsed from the SSE `data:` frames → `{output}`, an `AsyncIterable<StreamPart>`. `stream_options.include_usage` is set so the terminal `finish` part carries token usage.

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

## Snapshot

The model id and options are visible in the CEL-visible snapshot — useful for telemetry and debugging:

```yaml
inputs:
  modelName: !cel "resources.gpt4o.model"
```

Nothing needs redacting here: the key belongs to the client's credential, whose own output is marked `x-telo-sensitive` and omitted from trace payloads.

## Errors

A non-2xx response from `invoke` throws an actionable error built from the provider's `{ error: { message } }` body (falling back to the raw response text), prefixed with the HTTP status. No retry, no swallowing. Wrap in `try` / `catch` inside `Run.Sequence` if you want to handle them.

For streaming calls, a non-OK response or a mid-stream failure **rejects the iteration** rather than being yielded as a part. Already-emitted text-delta parts still reach the consumer, and the generic encoders (`Ndjson.Encoder`, `Sse.Encoder`) catch the rejection and frame it — carrying the error's `code` when it has one — so a client still sees partial output plus one terminal error record. Rejecting is what makes the failure reachable from a manifest: a `catch:` can name it, which a data part never could.

## Azure OpenAI / OpenAI-compatible gateways

Point the client at the endpoint — the controller appends `/chat/completions`. A server that requires no auth needs no `credential`:

```yaml
kind: Http.Client
metadata: { name: localClient }
baseUrl: http://localhost:11434/v1        # Ollama, vLLM, LM Studio, …
---
kind: Http.Request
metadata: { name: localRequest }
client: !ref localClient
---
kind: OpenAI.ChatModel
metadata: { name: localLlama }
model: llama3.1
request: !ref localRequest
```

These endpoints serve `/chat/completions`; almost none serve `/v1/responses`, which is why this pair is the portable one and the [responses kinds](./responses-model.md) are reached for deliberately, when reasoning is what you need.
