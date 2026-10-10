---
description: "Anthropic.MessagesModelStream: Claude over the Messages HTTP API, answered as a stream of parts. When the request is sent, the parts and their order, tool calls as they are written, thinking across a tool loop, and what rejects the call versus the iteration."
sidebar_label: Anthropic.MessagesModelStream
---

# `Anthropic.MessagesModelStream`

> Examples assume this module is imported under alias `Anthropic`, `ai` under `Ai` and `http-client` under `Http`. Substitute your own aliases.

`Anthropic.MessagesModelStream` implements `Ai.ModelStream` over Anthropic's `POST /v1/messages` with `stream: true`: one request, the answer as parts while it is written. It is the streaming twin of [`Anthropic.MessagesModel`](messages-model.md) and shares everything with it but the way the answer arrives — the configuration, the request translation, the cache breakpoints, the provider state and the failure list.

## Declaring one

```yaml
kind: Http.Client
metadata: { name: anthropicClient }
baseUrl: https://api.anthropic.com/v1
credential:
  kind: Http.ApiKeyHeader
  header: x-api-key
  key: !cel "secrets.anthropicApiKey"
---
kind: Http.Request
metadata: { name: anthropicRequest }
client: !ref anthropicClient
---
kind: Anthropic.MessagesModelStream
metadata: { name: claudeStream }
model: claude-sonnet-4-5
request: !ref anthropicRequest
maxTokens: 4096
```

Referenced from any `Ai.ModelStream` consumer:

```yaml
kind: Ai.AgentStream
metadata: { name: assistant }
model: !ref claudeStream
```

One `Http.Request` serves both kinds: each call says how it wants the body, so a buffered model and a streaming one may name the same request.

## Schema

The schema is [`Anthropic.MessagesModel`'s](messages-model.md#schema), field for field: `model`, `request`, `maxTokens` (required), `cacheLifetime`, `betas`, `options`. The same keys are refused in the resource's `options` — `model`, `messages`, `system`, `tools`, `toolChoice`, `tool_choice`, `stream`, `maxTokens`, `max_tokens` — and a call's own options may still name `maxTokens`.

## What the endpoint receives

The request is [the buffered kind's](messages-model.md#what-the-endpoint-receives) with `stream: true` added, under the same `anthropic-version` and `anthropic-beta` headers, and the response is asked for as a byte stream. Content parts, cache breakpoints and the replay of a carried `providerState` follow the same rules, because both kinds build the request with one translation.

**The request is built by the call and sent at the first read.** A stream that is opened and never read contacts nothing.

## The parts

The API sends an answer as events that build it one content block at a time. They come back as `Ai.StreamPart`s:

| Event | Part |
| --- | --- |
| a text block's `text_delta` | `text-delta` |
| a thinking block's `thinking_delta` | `reasoning-delta` |
| an `input_json_delta` of a `tool_use` block | `tool-call-delta` — `toolCallId` and `toolName` are the call's own, `delta` the next fragment of its argument JSON |
| an `input_json_delta` of any other block | no part — the block is not a call the caller runs; its input is carried in `provider-state` |
| a tool call's block closing | `tool-call` — `{ id, name, arguments }`, the arguments parsed once the text is whole |
| the answer completing, when it needs carrying | `provider-state` |
| the answer completing | `finish` — `usage` and `finishReason` |

Order: deltas as they are written; each `tool-call` directly after its own deltas; then at most one `provider-state`; then exactly one `finish`, which is always last.

- **A tool call is named from its first fragment.** The API opens a `tool_use` block with its `id` and `name` before any argument text, so every `tool-call-delta` carries the id the `tool-call` then carries.
- **A call's id is the endpoint's own when it gives a non-empty one; otherwise one is minted** (`call_<uuid>`) and written into the block — the same id on the deltas, on the `tool-call` and inside the carried `provider-state`. The buffered kind follows the same rule, so no call leaves either kind with an empty id.
- **Empty fragments are not reported.** A delta with no text yields no part.
- **Usage is assembled.** The opening event reports the input figures and the closing one the output count; a figure a later event repeats replaces the earlier one. They are mapped as [the buffered kind maps them](messages-model.md#usage): `promptTokens` is the three input figures added.
- **`finishReason`** is mapped from `stop_reason` by [the same table](messages-model.md#what-comes-back).
- **`ping` events and event types this module does not read are skipped**, so the API adding one changes nothing here.

### What completes a stream

The answer is complete on either of two events:

- **a `message_delta` carrying a `stop_reason`** — the endpoint's statement that the answer is finished, with the output usage beside it;
- **`message_stop`** — the trailer that follows it.

Reading goes on after the stop reason, up to `message_stop` or the end of the body, so an error event in that window still fails the stream. Then:

| The body | Outcome |
| --- | --- |
| reaches `message_stop`, or ends cleanly after a stop reason | `finish`, with the mapped reason and the merged usage |
| reaches `message_stop` with no stop reason seen | `finish` with `other` — never `stop`, since nothing declared a clean stop |
| ends with neither | `ERR_MODEL_RESPONSE_INVALID` |
| breaks while being read, even after a stop reason | `ERR_MODEL_RESPONSE_INVALID` (a cancellation stays a cancellation) |

**A content block still open when the answer completes is closed there**, in block order, before `provider-state` and `finish`. A text or thinking block is closed as it stands. A tool call is judged exactly as at its own close: argument text that is whole JSON yields the `tool-call`; text that is cut short is `ERR_MODEL_TOOL_ARGUMENTS_INVALID`. No call is ever emitted with partial arguments.

### Thinking across a tool loop

`provider-state` is emitted under the buffered kind's test: exactly when the finished answer holds a block whose type is neither `text` nor `tool_use`. It carries every block of the answer in order, assembled to the form a complete answer has — a thinking block with its whole text and its signature, a tool call and any other block that was sent input with that input parsed — tagged with the API, the model and the declaring resource. An answer of text and tool calls alone emits none.

`Ai.AgentStream` hands that state to the next model call, where it is replayed under [the three tests the buffered kind applies](messages-model.md#thinking-across-a-tool-loop). A state produced by one of the two kinds is not the other's: the tag names the resource.

## What rejects the call, and what rejects the iteration

**The call rejects** for everything the request alone decides, and nothing has been sent when it does:

- a content part the API cannot carry — `ERR_MODEL_CONTENT_UNSUPPORTED`;
- a `responseFormat`, or a call's `options` naming `model`, `messages`, `system`, `tools`, `toolChoice` or `stream` — `ERR_MODEL_REQUEST_REJECTED`;
- a request that could not be built for any other reason — `ERR_MODEL_REQUEST_REJECTED`, with the original as its `cause`.

A route's `catches:` or a `try:` step around the call can answer these.

**The iteration rejects** for everything the endpoint does, its refusal of the request included. `finish` is the only way a stream ends well; a failure is never a part.

| What happened | Code |
| --- | --- |
| The endpoint answered a status that is not a success | by status and error type, as for the buffered kind — a 429 is `ERR_MODEL_RATE_LIMITED` with `retryAfterSeconds` from `Retry-After` |
| The request did not complete — refused connection, timeout, unresolved host | `ERR_MODEL_UNREACHABLE` / `ERR_MODEL_TIMEOUT` |
| An `error` event, or any event carrying the API's error object, after the answer began | by the error's `type`, with no `status`: `overloaded_error` and `api_error` → `ERR_MODEL_UNAVAILABLE`, `rate_limit_error` → `ERR_MODEL_RATE_LIMITED`, and so on; a type nothing names → `ERR_MODEL_UNAVAILABLE` |
| A frame that is not a JSON object, or an event with no `type` | `ERR_MODEL_RESPONSE_INVALID` |
| An event for a content block the stream never opened | `ERR_MODEL_RESPONSE_INVALID` |
| A line over 1 MiB with no terminator, or one frame's payload over 1 MiB | `ERR_MODEL_RESPONSE_INVALID` |
| The stream ended with neither a stop reason nor `message_stop` — a cut connection, a proxy that closed | `ERR_MODEL_RESPONSE_INVALID` |
| The body broke while it was being read | `ERR_MODEL_RESPONSE_INVALID`, the transport's error kept as the cause |
| The answer could not be read for any other reason | `ERR_MODEL_RESPONSE_INVALID`, the original kept as the cause |
| A block that is not a tool call was sent input text that is not valid JSON once the block closes | `ERR_MODEL_RESPONSE_INVALID` |
| A tool call whose argument text is not valid JSON when its block closes or the answer completes, or is not a JSON object | `ERR_MODEL_TOOL_ARGUMENTS_INVALID`, `error.data.tool` naming it |
| `request` is not a live `Http.Request` | `ERR_INVALID_REFERENCE` |

The parts yielded before a failure still reach the consumer. A cancelled call is `ERR_INVOKE_CANCELLED`, never one of the model codes.

In a stream-mode route the response is committed before the first part, so a failure of the iteration cannot reach `catches:` — the encoder ends the stream with its error record, which carries the code. To answer an endpoint failure with a status of your own, read the stream to its end inside the handler (a `Run.Sequence` with `Stream.Collect`), or use the buffered kind.

## What stays open

- **Nothing before the first read.** The request is sent when the consumer first pulls.
- **A consumer that stops reading cancels the transport.** Leaving the iteration early returns the response body, and the request controller aborts on that.
- **A refused response is read for its explanation and released.** At most 2 KB of a non-success body is read into the error's message; the rest is let go. A body that breaks while it is read still raises the failure its status names, with the break as the error's cause; a cancellation stays a cancellation.
- **After `finish` nothing is read.** The body is returned as soon as `message_stop` arrives.

Read a stream to its `finish` or stop iterating it; a stream that was pulled once and then neither read nor returned holds its request open.

## Errors

The kind restates all thirteen codes [`Ai.ModelStream` declares](../../ai/README.md#catching-a-models-errors) in its `throws:` and raises nothing else. The status rows and the error-type table are the module's: [Errors](../README.md#errors).

## Snapshot

`resources.<name>` reads `model`, `maxTokens`, `cacheLifetime`, and `betas` / `options` when set. The kind holds no key, so there is nothing to redact.
