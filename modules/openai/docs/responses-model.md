---
description: "OpenAI.ResponsesModel and OpenAI.ResponsesModelStream: the /v1/responses API, buffered and streaming. Reasoning that survives a tool loop, the input-item translation, the named-event stream, and when to prefer these over the completions kinds."
sidebar_label: OpenAI.ResponsesModel
---

# `OpenAI.ResponsesModel`

> Examples assume this module is imported under alias `OpenAI` and `ai` under `Ai`. Substitute your own aliases.

Two kinds over OpenAI's `POST /v1/responses` API: `OpenAI.ResponsesModel` implements `Ai.Model` (buffered) and `OpenAI.ResponsesModelStream` implements `Ai.ModelStream`. They are the siblings of [`OpenAI.ChatModel` / `OpenAI.ChatModelStream`](./chat-model.md), which speak `/chat/completions`.

## Which pair to use

**Use the responses kinds when you want reasoning, especially with tools.** `/chat/completions` refuses the combination outright:

```
400: Function tools with reasoning_effort are not supported for <model> in
/v1/chat/completions. To use function tools, use /v1/responses or set
reasoning_effort to 'none'.
```

An agent is nothing but tools, so on the completions kinds it runs with reasoning off. These kinds are how a reasoning model drives a tool loop.

**Use the completions kinds for everything else**, and for every OpenAI-*compatible* endpoint. Azure OpenAI, Ollama, vLLM, Groq and OpenRouter serve `/chat/completions`; almost none serve `/v1/responses`.

They are separate kinds rather than one kind with a dialect switch because they share a vendor and little else — `input` items against `messages`, `instructions` against a system role, flat tools against nested ones, an `output` array against `choices`, named events against `[DONE]`-terminated chunks. Under one kind, `reasoning` would be a field that is sometimes a hard 400.

## Declaring one

The account is a plain `Http.Client`: it carries the base URL and the credential, so the key is declared once for every OpenAI kind in the app and the 401 re-acquire-and-retry is inherited rather than re-implemented.

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
kind: OpenAI.ResponsesModelStream
metadata: { name: model }
model: gpt-5-nano
request: !ref openaiRequest
reasoning: { effort: low }
```

Referenced from any `Ai.ModelStream` consumer:

```yaml
kind: Ai.AgentStream
metadata: { name: assistant }
model: !ref model
toolProviders:
  - provider: !ref tools
```

## Schema

Both kinds take the same fields.

| Field       | Type   | Required | Description |
| ----------- | ------ | -------- | ----------- |
| `model`     | string | yes      | Model identifier (`gpt-5-nano`, `gpt-5.2`, …). |
| `request`   | ref    | yes      | The `Http.Request` every call goes through. Its client carries the base URL and the credential. |
| `reasoning` | object | no       | `effort` (`minimal` \| `low` \| `medium` \| `high`) and `summary` (`auto` \| `concise` \| `detailed`). |
| `options`   | object | no       | camelCase request params, normalized to snake_case and merged into the body. Merged beneath the caller's options; downstream wins. The bag is open, so an unknown name is refused by the endpoint rather than caught here — the token cap is `maxOutputTokens` here and `maxTokens` on the chat kinds. |

`model`, `reasoning` and `options` are `x-telo-eval: compile`, so they resolve at load time from `variables.*` / `secrets.*`.

## Reasoning across a tool loop

Reasoning comes back **encrypted** and is replayed on the next request. That is what lets a model keep its chain of thought across the turns of a tool loop, and it is handled for you: the provider reports it as the contract's `providerState`, `Ai.Agent` / `Ai.AgentStream` carry it to the next turn, and the provider replays it.

The state is **tagged with the dialect, the model and the declaring resource**. The
resource is part of it because a model id alone is not identity: two resources can name
the same model over different accounts — a direct endpoint and a gateway — and an opaque
item minted by one is refused by the other. A transcript legitimately moves between models — a variable changed between deployments, an app declaring both pairs — and an item minted elsewhere is meaningless here, so a state whose tag does not match is dropped. The cost is one turn's reasoning; replaying a foreign item is a 400.

Nothing needs to be asked for: the encrypted reasoning arrives under default settings, with no `include` and no `store` flag.

`reasoning.summary` additionally asks for a readable précis of the thinking. That is what produces `reasoning-delta` parts on the streaming kind and `reasoning` content parts on the buffered one; without it, the reasoning is only ever replayed, never shown.

## What the endpoint receives

The translation from the provider-neutral contract:

| Contract | `/v1/responses` |
| -------- | --------------- |
| a `system` message | hoisted into `instructions` (several are joined) |
| a `user` message | `{role: user, content: [{type: input_text, …}, {type: input_image, …}]}` |
| an `assistant` message's text | `{role: assistant, content: [{type: output_text, …}]}` |
| an `assistant` message's `toolCalls` | one `{type: function_call, call_id, name, arguments}` item each |
| a `tool` message | `{type: function_call_output, call_id, output}` |
| `tools` | flat — `{type: function, name, description, parameters}` |
| `responseFormat` | `text.format`, and the VALUE is reshaped too — see below |
| `providerState` | the reasoning items, spliced in **before** the function calls they reasoned about |

Two details are load-bearing:

- **A tool call carries `call_id` AND `id`, and they are different values.** The contract's `ToolCall.id` is the `call_id` — the value a `function_call_output` answers. Keying on the item's own `id` produces a request the endpoint accepts and answers wrongly.
- **The reasoning items' position matters.** The endpoint requires a reasoning item to precede the call it reasoned about, and the contract hands state over out-of-band, so the position is reconstructed rather than appended.

**`responseFormat` differs in shape, not only in key.** A `json_schema` format is flat
here — `{type, name, schema, strict}` — and nested on the chat kinds —
`{type, json_schema: {name, schema, strict}}` — and each API refuses the other's form
(`Missing required parameter: 'text.format.name'` one way, `'response_format.json_schema'`
the other). Both kinds therefore normalize whichever form they are given, so one value
works on either and swapping providers under `Ai.Model` does not turn into a 400. Formats
other than `json_schema` pass through untouched.

An image in a **tool result** cannot ride a `function_call_output`, whose `output` is a string; it goes in a synthetic `user` message flushed after the run of outputs, never between them — the same pattern the completions dialect uses.

A content part a model produces but a caller cannot send (`reasoning`, `citation`, `refusal`) raises `ERR_INVALID_INPUT` rather than being dropped, which would send a request quietly missing part of the message.

## What comes back

The buffered kind reads the `output` array: `message` items become `text` (and `refusal`) content parts, `function_call` items become `toolCalls`, `reasoning` items become `providerState` — plus a `reasoning` content part when a summary was asked for.

The endpoint reports no `finish_reason`. It reports a run status, so:

| Observed | `finishReason` |
| -------- | -------------- |
| the turn asked for tools | `tool-calls` |
| `incomplete_details.reason: max_output_tokens` | `length` |
| `incomplete_details.reason: content_filter` | `content-filter` |
| `status: completed` | `stop` |
| anything else | `other` |

A run the endpoint answered `200` for and then reported as **failed** does not get a
finish reason at all — it raises `ERR_OPENAI_REQUEST_FAILED` carrying the endpoint's own
message. `Ai.FinishReason` has no `error` member, deliberately: a failure rejects, and a
reason code saying "the answer failed" competes with the mechanism that already reports
failure. Both halves behave the same way here.

Usage is renamed off `input_tokens` / `output_tokens` / `total_tokens`.

## The stream

Named events, not positional deltas, and no `[DONE]` sentinel:

| Event | Part |
| ----- | ---- |
| `response.output_text.delta` | `{type: text-delta, delta}` |
| `response.reasoning_summary_text.delta` | `{type: reasoning-delta, delta}` |
| `response.output_item.done` (a `function_call`) | `{type: tool-call, toolCall}` |
| `response.output_item.done` (a `reasoning` item) | collected, emitted once as `{type: provider-state, providerState}` |
| `response.completed` / `.incomplete` | `{type: finish, usage, finishReason}` |

Lifecycle frames (`response.created`, `.in_progress`, `.output_item.added`, `.content_part.*`, the `.done` twin of every delta) carry nothing the contract reports and are passed over — the vocabulary grows, and an unknown frame is not an error.

**A turn that calls a tool emits no text delta at all**, so a consumer must not wait for text to know a turn is under way.

**A stream fails by rejecting.** `finish` is the only terminator; a mid-stream `error` or `response.failed` frame raises `ERR_OPENAI_REQUEST_FAILED` carrying the provider's own words. Parts already emitted still reach the consumer. Rejecting is what makes the failure reachable from a manifest — a `catch:` can name it, which a data part never could.

## Errors

| Code | When |
| ---- | ---- |
| `ERR_OPENAI_REQUEST_FAILED` | The endpoint refused the request, reported the run as failed, or failed mid-stream. Carries the provider's message and the HTTP status. Also raised when a stream ends with no terminal event — an interrupted answer is reported as interrupted rather than as a clean stop with zero usage. |
| `ERR_INVALID_INPUT` | A content part that cannot be sent — one a model produces rather than receives. |
| `ERR_OPENAI_INVALID_TOOL_ARGUMENTS` | The model asked for a tool with arguments that are not a JSON object. |
| `ERR_INVALID_REFERENCE` | `request` did not resolve to a live `Http.Request` — a ref slot on a `with:`-scoped resource is not an injection site. |

A failed status carries the provider's explanation even on a streamed call: the body is read before the error is raised.
