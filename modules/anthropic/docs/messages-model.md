---
description: "Anthropic.MessagesModel: Claude over the Messages HTTP API with no vendor SDK. Configuration, the request the endpoint receives, content parts, prompt-cache breakpoints, thinking across a tool loop, usage and failures."
sidebar_label: Anthropic.MessagesModel
---

# `Anthropic.MessagesModel`

> Examples assume this module is imported under alias `Anthropic`, `ai` under `Ai` and `http-client` under `Http`. Substitute your own aliases.

`Anthropic.MessagesModel` implements `Ai.Model` over Anthropic's `POST /v1/messages`: one request, one complete answer. It is a `Telo.Invocable` with one declared, kernel-bound `invoke`, and it calls the HTTP API directly through an `Http.Request` you declare.

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
kind: Anthropic.MessagesModel
metadata: { name: claude }
model: claude-sonnet-4-5
request: !ref anthropicRequest
maxTokens: 4096
```

Referenced from any `Ai.Model` consumer:

```yaml
kind: Ai.Text
metadata: { name: summarizer }
model: !ref claude
```

For the answer as a stream of parts, the twin kind is [`Anthropic.MessagesModelStream`](messages-model-stream.md): the same fields, the same request and the same failures.

Declare the request at module level: a reference slot on a resource inside a `with:` scope is not injected, and a call through one fails with `ERR_INVALID_REFERENCE`.

## Schema

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `model` | string | yes | Model identifier. |
| `request` | ref to `Http.Request` | yes | The request every call goes through. Its client carries the base URL (`https://api.anthropic.com/v1`) and the `x-api-key` credential. |
| `maxTokens` | integer ≥ 1 | yes | The most tokens one answer may hold, thinking included. Sent as `max_tokens`. |
| `cacheLifetime` | `5m` \| `1h` | no, default `5m` | The lifetime of a cache entry written at a breakpoint. |
| `betas` | string[] | no | Sent comma-joined as the `anthropic-beta` header. |
| `options` | object | no | Default request parameters, camelCase at the top level. May not name `model`, `messages`, `system`, `tools`, `toolChoice` or `stream`, nor `maxTokens` / `max_tokens`. |

`model`, `maxTokens`, `cacheLifetime`, `betas` and `options` are `x-telo-eval: compile`, so they resolve at load time from `variables.*` / `secrets.*`.

`maxTokens` is said in one place on the resource: its `options` naming `maxTokens` or `max_tokens` is a `SCHEMA_VIOLATION` under `telo check`, and a computed bag naming it is refused when the resource is created (`ERR_RESOURCE_SCHEMA_VALIDATION_FAILED`). A **call's** options — the operation's `options` merged with the caller's `inputs.options` — may name `maxTokens`, which then replaces the field's value for that call.

There is no `apiKey`, no `baseUrl` and no `thinking` field. The first two belong to the client; thinking is a request parameter, set through `options`.

## What the endpoint receives

Every call is `POST /messages` relative to the client's `baseUrl`, with `content-type: application/json`, `anthropic-version: 2023-06-01`, the client's credential header, and `anthropic-beta` when `betas` is set.

The translation from the provider-neutral contract:

| Contract | Messages API |
| --- | --- |
| the kind's `model`, `maxTokens` | `model`, `max_tokens` |
| every `system` message, wherever it sits | hoisted, in order, into the top-level `system` list — one `text` block per string or text part |
| a `user` message | `{role: user, content: [...]}` — `text`, `image` and `document` blocks |
| an `assistant` message | `{role: assistant, content: [...]}` — its text as `text` blocks, then one `{type: tool_use, id, name, input}` per entry of `toolCalls` |
| a run of consecutive `tool` messages | **one** `{role: user}` turn: a `{type: tool_result, tool_use_id, content}` per message, in order, then the files those results returned |
| `tools` | `{name, description, input_schema}` each |
| `toolChoice` | `tool_choice: {type: auto}` or `{type: none}`, sent only beside `tools`; `none` keeps the tools declared and forbids a new call |
| `options` | merged into the body, top-level keys snake_cased |
| `providerState` | replaces the newest assistant message's blocks — see [below](#thinking-across-a-tool-loop) |
| `responseFormat` | refused: `ERR_MODEL_REQUEST_REJECTED` |

Details that matter:

- **A tool call's id is the endpoint's own.** `ToolCall.id` is the `tool_use` block's `id`, and a tool message's `toolCallId` goes back as `tool_use_id` unchanged. A block the endpoint returned with no id, or an empty one, is given a minted one (`call_<uuid>`) that is also written into the block inside `providerState`, so the call, its result and the replayed turn agree. The stream kind follows the same rule; no call leaves either kind with an empty id.
- **An empty text is left out.** The API refuses an empty text block, so an empty string or an empty text part sends no block, and a `user` or `assistant` message left with no blocks sends no turn. A tool result's text is sent as it is, empty or not.
- **An assistant message is sent as its text and its calls.** Parts a model produces beside its text (`reasoning`, `refusal`, `citation`) are not sent back; what has to survive verbatim rides `providerState`.
- **Options are written last but one.** `tool_choice` is written after the merged options, so the call's own choice is what is sent; a call's `options.maxTokens` is written after the kind's `maxTokens` and replaces it.

### Content parts

| Part | Block |
| --- | --- |
| `text` | `{type: text, text}` |
| `image`, bytes, `image/jpeg` \| `image/png` \| `image/gif` \| `image/webp` | `{type: image, source: {type: base64, media_type, data}}` |
| `image` of those types, `http:` / `https:` `uri` | `{type: image, source: {type: url, url}}` |
| `file`, `application/pdf`, bytes | `{type: document, source: {type: base64, media_type: application/pdf, data}, title}` |
| `file`, `application/pdf`, `http:` / `https:` `uri` | `{type: document, source: {type: url, url}, title}` |
| `file`, `text/plain`, bytes | `{type: document, source: {type: text, media_type: text/plain, data}, title}` — `data` is the text, decoded as UTF-8 |

`title` is the part's `name`, left out when it has none. A media type is compared without its parameters (`text/plain; charset=utf-8` is `text/plain`). Bytes are sent base64-encoded whether the part held raw bytes or a base64 string.

Everything else is `ERR_MODEL_CONTENT_UNSUPPORTED`, raised while the request is built and before anything is sent: audio, video, an image or file of another media type, a plain-text file by `uri`, a `uri` whose scheme is not `http:` or `https:` (`error.data.scheme` names it), a part a model produces submitted in a user message, and anything but text in a system message. `error.data` is `{ partType, mediaType?, scheme? }`, and the message says what the endpoint takes instead. A part that is *malformed* never gets this far — its shape is [`Ai.ContentPart`'s](../../ai/docs/ai-model.md#modality-lives-in-the-parts), refused by the contract (`ERR_INPUT_INVALID`).

**In a tool result**, a string or text-only content is sent as the result's text. A result holding media is sent as a block list in the tool's own part order — its text and images — and its files follow the turn's results as `document` blocks, because a result cannot hold one. The same refusals apply; a part a model produces is left out of a result rather than refused.

### Cache breakpoints

A part's `cacheBreakpoint: true` becomes `cache_control` on its block: `{type: ephemeral}` at the default lifetime, `{type: ephemeral, ttl: 1h}` under `cacheLifetime: 1h`.

- Breakpoints are counted in request order — the `system` blocks, then the turns — and **the last four are sent**; earlier ones are dropped. Nothing is raised.
- A breakpoint on a system text part marks that `system` block, which covers the tools and the prompt before it.
- A breakpoint on a text or image part inside a tool result marks the `tool_result` block, the block the API caches at. One on a returned file marks its `document` block.
- A breakpoint on an assistant message's text part marks that text block; when the turn is replayed from `providerState`, it marks the last replayed block that is not thinking.

## What comes back

| Answer | Result |
| --- | --- |
| a `text` block | a `text` content part, and its text appended to `text` |
| a `thinking` block | a `reasoning` content part holding the thinking text |
| a `tool_use` block | an entry of `toolCalls` — `{ id, name, arguments }`, `arguments` the block's `input` |
| a `redacted_thinking` block, or a block of another type | nothing in `content`; kept in `providerState` |

A `tool_use` block whose `input` is not a JSON object is `ERR_MODEL_TOOL_ARGUMENTS_INVALID` with `error.data.tool`, rather than a call run with empty arguments.

| `stop_reason` | `finishReason` |
| --- | --- |
| `end_turn`, `stop_sequence` | `stop` |
| `max_tokens`, `model_context_window_exceeded` | `length` |
| `tool_use` | `tool-calls` |
| `refusal` | `content-filter` |
| `pause_turn`, anything else | `other` |

A refusal is an answer: the call returns, with whatever content the model gave before declining.

### Usage

The API reports its input in three separate figures. They are added, because the contract's `promptTokens` is the whole prompt:

| Result | From |
| --- | --- |
| `promptTokens` | `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens` |
| `cachedPromptTokens` | `cache_read_input_tokens`, when reported |
| `cacheWritePromptTokens` | `cache_creation_input_tokens`, when reported |
| `completionTokens` | `output_tokens` |
| `totalTokens` | `promptTokens` + `completionTokens` |

A cache share the endpoint does not report is absent, which is not zero. The API gives no separate count of thinking tokens, so `reasoningTokens` is absent; thinking is part of `completionTokens`.

### Thinking across a tool loop

With extended thinking on, the API requires the assistant turn that asked for tools to come back exactly as it was returned — thinking blocks and their signatures included — beside the tool results. The contract's `providerState` carries it.

**When a state is returned.** An answer returns `providerState` exactly when it holds a block whose type is neither `text` nor `tool_use` — a `thinking` or `redacted_thinking` block, or a block type this module does not read. The test is the block's type alone. The state is that turn's content blocks verbatim and in order, tagged with the API, the model and the declaring resource. **An answer with no such block returns no `providerState`**: a turn of text and tool calls is fully held by its message.

**When a state is replayed.** `Ai.Agent` hands the last state it was given to every later model call. There it replaces one assistant message's blocks, in place, when all three hold; otherwise it is ignored, without error, and every turn is rebuilt from the messages:

1. **It is this resource's own** — its tag names the Messages API, this resource's `model` and this resource (module-qualified).
2. **The candidate is the newest assistant message** — the last `assistant` message of the call's `messages` as received, whatever follows it.
3. **It is that turn** — the state's `tool_use` ids equal the message's `toolCalls` ids, same count and same order. For a turn that made no call, the state's text must equal the message's text and be non-empty: an empty text identifies nothing.

What follows from that:

- **A conversation that was cut back or edited**: the newest assistant message is whatever is now last. When that is a different turn, the state is ignored — a transcript moved from another provider, model or resource loses one turn's thinking and nothing else.
- **A state belonging to a turn that is not the newest** is never replayed, even while that turn is still in the list; the turn is rebuilt from its message. This is the ordinary case: an agent keeps forwarding a state after a later answer returned none.
- **No assistant message in the list**: the state is ignored.
- **An edit to the newest turn that keeps its ids**: the state's blocks are sent, not the edit — the API takes a thinking turn only unmodified. A caller that edits the newest turn drops the state with it.
- **Two answers with identical non-empty text and no tool calls** cannot be told apart; a state of the older one is replayed before the newer.

Nothing needs declaring for this beyond turning thinking on in `options`.

## Errors

The kind restates all thirteen codes [`Ai.Model` declares](../../ai/README.md#catching-a-models-errors) in its `throws:` and raises nothing else. How a status, the endpoint's own error object, a transport failure or an unreadable answer becomes one of them: [Errors](../README.md#errors).

| Code | On this API |
| --- | --- |
| `ERR_MODEL_CONTENT_UNSUPPORTED` | A well-formed content part the API cannot carry — see [Content parts](#content-parts). Raised by the call, before any request; `error.data` is `{ partType, scheme?, mediaType? }`. |
| `ERR_MODEL_REQUEST_REJECTED` | Before any request: a `responseFormat`, or a call's `options` naming `model`, `messages`, `system`, `tools`, `toolChoice` or `stream`. From the endpoint: a request it cannot serve (`invalid_request_error`, `not_found_error`, any other 4xx). Also a request that could not be built (`cause` holds the original). |
| `ERR_MODEL_CONTEXT_TOO_LONG` | A 413 or `request_too_large`, or an invalid request whose message says the prompt is too long. |
| `ERR_MODEL_TOOL_ARGUMENTS_INVALID` | A `tool_use` block whose `input` is not a JSON object; `error.data.tool` names it. |
| `ERR_MODEL_RESPONSE_INVALID` | A 2xx body that is empty, not JSON, not an object, or carries no `content` list; or a member of it has the wrong shape, or it could not be read for any other reason (`cause` holds the original). |
| `ERR_INVALID_REFERENCE` | `request` did not resolve to a live `Http.Request`. |
| the rest | By the endpoint's status and its error type — a rate limit is `ERR_MODEL_RATE_LIMITED` with `error.data.retryAfterSeconds`, a bad key `ERR_MODEL_ACCESS_DENIED`, an exhausted balance `ERR_MODEL_QUOTA_EXCEEDED`, an overloaded endpoint `ERR_MODEL_UNAVAILABLE`. |

Every `Ai` operation holding this kind passes the codes on, so a route over an `Ai.Text` or an `Ai.Agent` names them in `catches:` exactly as a route over the model does — and the same list holds for any other provider's model:

```yaml
catches:
  - when: !cel "error.code == 'ERR_MODEL_RATE_LIMITED' || error.code == 'ERR_MODEL_UNAVAILABLE'"
    status: 503
    content:
      application/json:
        body:
          retryAfterSeconds: !cel "has(error.data.retryAfterSeconds) ? error.data.retryAfterSeconds : 0"
  - status: 502
    content: { application/json: { body: { code: !cel "error.code" } } }
```

The request this kind is handed is asked for its body as text, never as parsed JSON, so a `success:` / `retryOn:` rule on that request sees `body` undecoded.

## Snapshot

`resources.<name>` reads `model`, `maxTokens`, `cacheLifetime`, and `betas` / `options` when set. The kind holds no key, so there is nothing to redact.
