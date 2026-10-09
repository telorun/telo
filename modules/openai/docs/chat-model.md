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

- `OpenAI.ChatModel.invoke({messages, options, tools?, toolChoice?, responseFormat?})` → a buffered request → `{content, text, usage, finishReason, toolCalls?}`. `responseFormat` is sent as `response_format`, and a `json_schema` format is normalized into this API's nested `{type, json_schema: {…}}` form — the responses kinds take the same contract value flat under `text.format`, and each API refuses the other's shape, so both kinds reshape rather than pass through.
- `OpenAI.ChatModelStream.invoke({messages, options, tools?, toolChoice?})` → a `stream: true` request, parsed from the SSE `data:` frames → `{output}`, an `AsyncIterable<StreamPart>`. `stream_options.include_usage` is set so the terminal `finish` part carries token usage.

`toolChoice` (`auto` | `none`, legal only beside `tools`) is sent as `tool_choice` on both kinds. `none` keeps the `tools` in the request — a conversation holding earlier tool calls is only valid while they are described — and tells the model to answer without calling one; this is what an agent's concluding call sends. It is written after the merged `options`, so the call's own choice is what goes out.

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

On the **streaming** path, OpenAI splits each tool call across many `delta.tool_calls[]` fragments keyed by `index` — the first carries `id` and `function.name`, later ones append `function.arguments` string fragments. The provider accumulates per index and, at the finish boundary (arguments are only valid JSON once fully joined), emits one `{ type: "tool-call", toolCall }` `StreamPart` per assembled call before the terminal `finish`.

Each argument fragment is also reported as it arrives, as `{ type: "tool-call-delta", toolCallId, toolName, delta }` — `toolCallId` being the `id` the call's `tool-call` part then carries, and a call's `delta`s joining to its argument JSON. Nothing is reported for a call until the endpoint has sent both its `id` and its name: an OpenAI-compatible endpoint that sends the id after the first fragment has those fragments held and released as one delta when the id arrives. An endpoint that never sends an id gets one generated for the call, `call_<uuid>`, carried by its deltas (released immediately before the call) and by the call alike. A generated id is unique: the positional `call_<index>` this kind used to fall back to repeated on every model call of one agent run.

This is what lets [`Ai.AgentStream`](../../ai/docs/ai-agent-stream.md) drive a tool-use loop with live token streaming; `Ai.TextStream` never passes `tools`, so it never observes these parts.

## Multimodal content

Message `content` may be a string or [content parts](../../ai/docs/ai-model.md#modality-lives-in-the-parts). Which parts each API carries:

| Part | Chat completions (`OpenAI.ChatModel`, `ChatModelStream`) | Responses (`OpenAI.ResponsesModel`, `ResponsesModelStream`) |
| --- | --- | --- |
| text | yes | yes |
| image by bytes (`data`) | yes — a `data:` URL | yes — a `data:` URL |
| image by `http:` / `https:` `uri` | yes — the string as written | yes — the string as written |
| file by bytes (`data`), with `name` (sent as its filename) | yes | yes |
| file by bytes with no `name` | `ERR_CONTENT_UNSUPPORTED` | `ERR_CONTENT_UNSUPPORTED` |
| file by `http:` / `https:` `uri` | `ERR_CONTENT_UNSUPPORTED` | yes — the string as written |
| any other `uri` scheme (`file:`, `s3:`, …) | `ERR_CONTENT_UNSUPPORTED`, `error.data.scheme` set | the same |
| audio, video | `ERR_CONTENT_UNSUPPORTED` | `ERR_CONTENT_UNSUPPORTED` |
| a part a model produces (`reasoning`, `citation`, `refusal`, `tool-call`) sent as input | `ERR_CONTENT_UNSUPPORTED` | `ERR_CONTENT_UNSUPPORTED` |

`ERR_CONTENT_UNSUPPORTED` is raised while the request is built — by the call itself, on the streaming kind too, and before anything is sent. Its message names the part type, its media type and what the endpoint takes instead; `error.data.partType` is the refused part's `type`, and `error.data.scheme` the `uri`'s scheme when the scheme is the reason. A `uri` is passed to the endpoint exactly as written and never fetched here: the endpoint must be able to reach it. A part that is *malformed* never gets this far — its shape is [`Ai.ContentPart`'s](../../ai/docs/ai-model.md#modality-lives-in-the-parts), refused by the contract (`ERR_INPUT_INVALID`).

A file by bytes needs `name`: both APIs take the bytes beside a filename, so one without is refused here (`error.data.partType: file`, no `scheme`) rather than sent; a file by `uri` on the responses kinds needs none. The provider gates on no media type. At OpenAI's own endpoint a file by bytes on chat completions is a PDF; any other type is the endpoint's to accept or refuse, and a refusal is `ERR_OPENAI_REQUEST_FAILED`.

How a carried part lands on this API's wire:

- A **user** message with parts becomes an OpenAI content array. Text → `{ type: "text", text }`. An image → `{ type: "image_url", image_url: { url } }`, where `url` is the part's `uri`, or a `data:<mediaType>;base64,…` URL built from its bytes (or its base64 string). A file → `{ type: "file", file: { filename, file_data } }`, `filename` being the part's `name` (required for a file by bytes) and `file_data` the same `data:` URL form. **System** messages can't carry media, so any parts are flattened to their text.
- A **tool** message can't carry media in OpenAI chat completions. When a tool answered with an image or a file, the provider emits the `tool` message with its text parts (or a short placeholder when it has none) and then a **synthetic follow-up `user` message** holding the media parts — flushed after the whole run of tool messages, never between them. The Ai contract stays provider-neutral; only this translation differs. A tool result's media part this API cannot carry — audio, video, a `uri` it cannot be handed, a file by bytes with no `name` — is refused like any other; a part a model produces inside a tool result is left out, not refused. The follow-up message and the placeholder are this API's alone: the [responses kinds](./responses-model.md#content-parts) put a tool's media in the tool's own output.

## Usage

`usage` carries `promptTokens`, `completionTokens` and `totalTokens`, plus `cachedPromptTokens` (from `prompt_tokens_details.cached_tokens`) and `reasoningTokens` (from `completion_tokens_details.reasoning_tokens`) when the endpoint reports them. A compatible endpoint that omits the detail objects leaves both absent, which is not zero. The streaming kind asks for usage (`stream_options.include_usage`) and reports it on `finish`.

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

| Code | When |
| ---- | ---- |
| `ERR_OPENAI_REQUEST_FAILED` | The endpoint refused the request or failed mid-stream. Carries the provider's message and the HTTP status. |
| `ERR_CONTENT_UNSUPPORTED` | A well-formed content part this API cannot carry — see [Multimodal content](#multimodal-content). Raised by the call, before any request; `error.data` is `{ partType, scheme? }`. |
| `ERR_OPENAI_INVALID_TOOL_ARGUMENTS` | The model asked for a tool with arguments that are not a JSON object. |
| `ERR_INVALID_REFERENCE` | `request` did not resolve to a live `Http.Request` — a ref slot on a `with:`-scoped resource is not an injection site. |

Every `Ai` operation holding one of these kinds passes the codes on, so a route over an `Ai.Text` or an `Ai.AgentStream` names them in `catches:` exactly as a route over the model does:

```yaml
catches:
  - when: !cel "error.code == 'ERR_CONTENT_UNSUPPORTED'"
    status: 422
    content:
      application/json:
        body: { unsupported: !cel "error.data.partType" }
  - status: 502
    content: { application/json: { body: { code: !cel "error.code" } } }
```

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
