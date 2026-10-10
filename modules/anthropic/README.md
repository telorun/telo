# Anthropic

Claude models over Anthropic's Messages API. Calls the HTTP API directly — no vendor SDK — through an `Http.Request` you declare, so the API key and the base URL live on an ordinary `Http.Client`.

## Kinds

| Kind | Implements | Purpose |
| --- | --- | --- |
| `Anthropic.MessagesModel` | `Ai.Model` | A Claude model called for a complete answer, over `POST /v1/messages`. |
| `Anthropic.MessagesModelStream` | `Ai.ModelStream` | The same model called for a stream: text and thinking deltas, tool calls as they are written, then usage. |

Each is used wherever its abstract is: `MessagesModel` by `Ai.Text`, `Ai.Agent` or a route calling the model directly, `MessagesModelStream` by `Ai.TextStream` and `Ai.AgentStream`. The two share their configuration, their request translation and their failures, and both may name one `Http.Request`.

## Example

```yaml
kind: Telo.Application
metadata: { name: Assistant, version: 1.0.0 }
imports:
  Ai: oci://ghcr.io/telorun/ai@<version>
  Anthropic: oci://ghcr.io/telorun/anthropic@<version>
  Http: oci://ghcr.io/telorun/http-client@<version>
secrets:
  anthropicApiKey:
    env: ANTHROPIC_API_KEY
    type: string
---
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
---
kind: Ai.Agent
metadata: { name: assistant }
model: !ref claude
system:
  - { type: text, text: "You are a careful assistant.", cacheBreakpoint: true }
```

Replace each `<version>` with a published one from the [hub](https://hub.telo.run).

## The account is an `Http.Client`

A model kind carries **no credential and no base URL**. It references an `Http.Request`, whose client holds both:

- `baseUrl` is the endpoint up to its version segment — `https://api.anthropic.com/v1`, or a gateway's. The kind posts to `/messages` beneath it.
- `credential` is an `Http.ApiKeyHeader` on `x-api-key`. Its returned header is marked sensitive, so the key is redacted in trace payloads; nothing on the model kind can leak it.
- The client's `timeout` and the request's `retry:` policy are the only timeout and retry there are. Nothing here retries. A complete answer arrives in one response, so give the client a timeout that fits the longest answer you allow.

What a model kind itself adds to every call is two headers: `anthropic-version: 2023-06-01`, the dialect its translation is written against, and `anthropic-beta`, the comma-joined `betas` list when you declare one.

## Configuration

Both kinds take the same fields.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `model` | string | yes | Model identifier (`claude-sonnet-4-5`, `claude-haiku-4-5`, …). |
| `request` | ref | yes | The `Http.Request` every call goes through. |
| `maxTokens` | integer ≥ 1 | yes | The most tokens one answer may hold, thinking included. The API has no default, so neither does the kind. |
| `cacheLifetime` | `5m` \| `1h` | no (`5m`) | How long a prompt-cache entry written at a breakpoint lives. |
| `betas` | string[] | no | Opt-in API features, sent as `anthropic-beta`. |
| `options` | object | no | Default request parameters — see below. May not name `maxTokens`. |

The schema is closed: an undeclared field is a `SCHEMA_VIOLATION` under `telo check`.

### Options

`options` is an open bag of Messages API request parameters. Top-level keys are written camelCase and sent snake_case (`topP` → `top_p`, `stopSequences` → `stop_sequences`); values are sent as written, so a nested object keeps the API's own spelling. The kind's `options` sit beneath the operation's and the call's; downstream wins.

An option may not name what the call itself decides: `model`, `messages`, `system`, `tools`, `toolChoice` and `stream`. On the resource that is a `SCHEMA_VIOLATION`; in a per-call bag, which is computed data, the call is refused with `ERR_MODEL_REQUEST_REJECTED` before anything is sent.

**The token cap has one home on the resource, and a call may still override it.** The resource's `options` may not name `maxTokens` (or `max_tokens`) either — the `maxTokens` field is where the resource says it, and a second entry would leave the winner to merge order. That too is a `SCHEMA_VIOLATION`, and a computed bag naming it is refused when the resource is created. The options a *call* arrives with — an operation's own `options` merged with the caller's `inputs.options` — may name `maxTokens`, and then it replaces the field's value for that call: a call that raises a thinking budget can raise the cap with it.

**Extended thinking** is turned on through `options`, since its shape is the API's and differs between model generations:

```yaml
kind: Anthropic.MessagesModel
metadata: { name: thinker }
model: claude-sonnet-4-5
request: !ref anthropicRequest
maxTokens: 16000
options:
  thinking: { type: enabled, budget_tokens: 8000 }
```

What comes back is handled without configuration: thinking text is a `reasoning` content part, and the turn is carried through a tool loop so the model keeps its chain of thought (see [the kind's reference](docs/messages-model.md#thinking-across-a-tool-loop)).

**A response format is not supported.** A call carrying the model contract's `responseFormat` is refused with `ERR_MODEL_REQUEST_REJECTED` rather than sent without it.

## What a message can carry

| Part | Sent as |
| --- | --- |
| text | a `text` block |
| image by bytes — `image/jpeg`, `image/png`, `image/gif`, `image/webp` | an `image` block, base64 source |
| image of those types by `http:` / `https:` `uri` | an `image` block, URL source — the string as written |
| file `application/pdf` by bytes or by `http:` / `https:` `uri` | a `document` block, `name` as its title |
| file `text/plain` by bytes | a `document` block holding the text, `name` as its title |
| any other image or file media type; a `text/plain` file by `uri`; any other `uri` scheme (`file:`, `s3:`, …); audio; video | `ERR_MODEL_CONTENT_UNSUPPORTED` |
| a part a model produces (`reasoning`, `citation`, `refusal`, `tool-call`) in a user message | `ERR_MODEL_CONTENT_UNSUPPORTED` |
| anything but text in a system message | `ERR_MODEL_CONTENT_UNSUPPORTED` |

A part the API cannot carry is refused by the call, before anything is sent, with `error.data.partType`, `error.data.mediaType` when the part has one, and `error.data.scheme` when the `uri`'s scheme is the reason. A `uri` is handed to the endpoint as written and never fetched here, so the endpoint must be able to reach it.

Media a **tool** returned rides the tool's own result: its text and images inside the result, its files directly after the results of that turn.

## Streaming

`Anthropic.MessagesModelStream` sends the same request with `stream: true` and reads the endpoint's event stream into the model contract's parts:

```yaml
kind: Anthropic.MessagesModelStream
metadata: { name: claudeStream }
model: claude-sonnet-4-5
request: !ref anthropicRequest
maxTokens: 4096
---
kind: Ai.AgentStream
metadata: { name: assistant }
model: !ref claudeStream
```

- **Parts, in order**: `text-delta` and `reasoning-delta` as they are written; `tool-call-delta` fragments of a call's arguments, under the call's own id and name from the first one; the whole `tool-call` when its arguments are complete; one `provider-state` when the answer holds thinking to carry; one terminal `finish` with usage and the finish reason. The answer is complete on the event carrying its stop reason or on the closing `message_stop`, whichever the body reaches.
- **The request is sent at the first read.** The call builds it and returns; a stream nobody reads contacts nothing, and a consumer that stops reading cancels the transport.
- **What the request alone decides rejects the call** — an unsupported content part, a `responseFormat`, a structural option — before anything is sent. **Everything the endpoint does rejects the iteration**, its refusal of the request included.

Detail: [`Anthropic.MessagesModelStream`](docs/messages-model-stream.md).

## Prompt caching

The API caches a prompt prefix only where it is told to. A content part's `cacheBreakpoint: true` is that instruction: the request from its start through that part — tools, system prompt and every message before it — is written to the cache and read from it on the next request that begins the same way.

- Entries live for `cacheLifetime`: five minutes by default, or one hour.
- The API takes four breakpoints in one request. When a request holds more, the **last four in request order** are sent and the earlier ones dropped; a breakpoint never raises an error.
- Mark the system prompt of an agent whose tools and prompt are stable — write `system` as a list of text parts — and it covers both.
- `usage.cachedPromptTokens` is what a call read from the cache and `usage.cacheWritePromptTokens` what it wrote. `usage.promptTokens` is the whole prompt, those two shares included.

## Errors

Both kinds raise **only the failures `Ai.Model` and `Ai.ModelStream` declare** — the same thirteen codes every provider raises — and each restates the whole list, so a `catches:` written against them holds when the model behind it is swapped for another provider's. The codes, their `error.data` and which are worth another try: [`ai` → Catching a model's errors](../ai/README.md#catching-a-models-errors).

How this module arrives at a code:

| What happened | Code |
| --- | --- |
| The endpoint answered 401 or 403 | `ERR_MODEL_ACCESS_DENIED` |
| 402 | `ERR_MODEL_QUOTA_EXCEEDED` |
| 429 | `ERR_MODEL_RATE_LIMITED`, with `retryAfterSeconds` from `Retry-After` |
| 408 or 504; the request timed out | `ERR_MODEL_TIMEOUT` |
| 413 | `ERR_MODEL_CONTEXT_TOO_LONG` |
| any other 4xx; a status that is neither a success nor an error; a success the request's own `success:` rule refused | `ERR_MODEL_REQUEST_REJECTED` |
| 5xx, 529 included | `ERR_MODEL_UNAVAILABLE`, with `retryAfterSeconds` when the response named a wait |
| The connection was refused, the host did not resolve, the handshake failed | `ERR_MODEL_UNREACHABLE` |
| A 2xx body that is empty, not JSON, not an object, or carries no `content` list; a member of it has the wrong shape; or it could not be read for any other reason | `ERR_MODEL_RESPONSE_INVALID`, the original kept as the error's cause when there is one |
| In a stream: a frame that is not a JSON object, an event with no `type` or for a block never opened, a line or a frame over 1 MiB, a body that breaks, or an end with neither a stop reason nor the closing `message_stop` event | `ERR_MODEL_RESPONSE_INVALID` |
| In a stream: an `error` event after the answer began | by its `error.type`, with no `status` |
| A content part this API cannot carry | `ERR_MODEL_CONTENT_UNSUPPORTED`, before anything is sent |
| A tool call whose input is not a JSON object, or whose streamed argument text is not valid JSON once complete | `ERR_MODEL_TOOL_ARGUMENTS_INVALID` |
| A `responseFormat`, or a structural key in a call's `options` | `ERR_MODEL_REQUEST_REJECTED`, before anything is sent |
| The request could not be built for any other reason | `ERR_MODEL_REQUEST_REJECTED`, no `status`, before anything is sent, the original kept as the error's cause |
| `request` is not a live `Http.Request` | `ERR_INVALID_REFERENCE` |
| The request's credential holds no material (`ERR_INVALID_CREDENTIAL`) | `ERR_MODEL_ACCESS_DENIED`, no `status` |
| Any other failure of the request — a `success:` / `retryOn:` rule that resolves to neither a list nor a boolean, a credential's own error, an uncoded error | `ERR_MODEL_REQUEST_REJECTED`, no `status`, the original kept as the error's cause |

**The endpoint's own error object is read wherever it turns up** — a failed response's body, a 2xx body, or an event of a stream — and it wins over any answer beside it. The API names a failure by `error.type`. These types name one failure, and a match wins over the status:

| `error.type` | Code |
| --- | --- |
| `authentication_error`, `permission_error` | `ERR_MODEL_ACCESS_DENIED` |
| `billing_error` | `ERR_MODEL_QUOTA_EXCEEDED` |
| `rate_limit_error` | `ERR_MODEL_RATE_LIMITED` |
| `request_too_large`; `invalid_request_error` whose message says the prompt is too long | `ERR_MODEL_CONTEXT_TOO_LONG` |
| `timeout_error` | `ERR_MODEL_TIMEOUT` |
| `overloaded_error` | `ERR_MODEL_UNAVAILABLE` |

With no such type, the status rows above decide when a response carried the failure. Only when none did — an error inside a 2xx body or a stream event — are the remaining types read: `invalid_request_error` / `not_found_error` → `ERR_MODEL_REQUEST_REJECTED`, `api_error` → `ERR_MODEL_UNAVAILABLE`. Anything still unnamed is `ERR_MODEL_UNAVAILABLE`. The vendor's type is never put in `error.data`; its message is in the error's message.

`status` is in `error.data` whenever a response carried the failure, whichever row decided the code. `retryAfterSeconds` comes only from the standard `Retry-After` header.

**A refusal is an answer, not an error.** A model that declines returns normally with `finishReason: content-filter`; `ERR_MODEL_CONTENT_REFUSED` is declared, as on every provider, and this API has no rejection that maps to it.

**`throwOnHttpError` changes nothing a caller can see but the wait.** With it set on the client, `http-client` raises `ERR_HTTP_STATUS` before this module sees the response; that is classified from the status and body it carries, to the same codes — without `retryAfterSeconds`, since that error carries no headers.

**A model kind decodes the answer itself.** A call asks the request for the body as text — or, from the stream kind, as a byte stream — never as parsed JSON, so what a response's `Content-Type` claims decides nothing. One consequence for a request handed to either kind: its own `success:` / `retryOn:` rule sees `status` and `headers` as usual, but `body` is undecoded. One limit of the buffered kind: a body that breaks mid-transfer is reported by the transport as a network failure, so it arrives as `ERR_MODEL_UNREACHABLE`; the stream kind reads the body itself and raises the break as `ERR_MODEL_RESPONSE_INVALID`.

**A streamed failure arrives at the read, not from the call.** The stream kind sends its request when the stream is first read, so every row above that the endpoint or the transport causes rejects the iteration; only what the request alone decides rejects the call.

A cancelled call is `ERR_INVOKE_CANCELLED`, never one of the model codes; a durable suspension and the kernel's contract errors (`ERR_INPUT_INVALID`, `ERR_OUTPUT_INVALID`, `ERR_CONTRACT_UNRESOLVABLE`, `ERR_SCHEMA_PROJECTION_UNRESOLVED`, `ERR_FUNCTION_FAILED`, `ERR_PREDICATE_NOT_BOOLEAN`) pass through unchanged.

## Requirements

The module declares `requires: telo: ">=0.114.0"`; an older runtime reports `MODULE_REQUIRES_NEWER_RUNTIME`.

## Live tests

`modules/anthropic/tests/integration/` holds tests against the real API: a complete answer, a streamed one, a tool loop with thinking under both kinds, a cache write then read, and a refused key. Each skips when `ANTHROPIC_API_KEY` is unset, and they run through `pnpm run test:integration`, never the module suite.

## Reference

- [`Anthropic.MessagesModel`](docs/messages-model.md) — the request the endpoint receives, what comes back, thinking across a tool loop.
- [`Anthropic.MessagesModelStream`](docs/messages-model-stream.md) — the parts and their order, what rejects the call and what rejects the iteration, what a stream holds open.
