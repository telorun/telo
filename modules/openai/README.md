# OpenAI

Every OpenAI surface under one import: chat models (buffered and streaming), image
generation, and text embeddings. Calls the HTTP APIs directly — no vendor SDK.

The same controller serves every OpenAI-**compatible** endpoint (Azure OpenAI, gateways,
Ollama, vLLM, Groq, Together, OpenRouter, …) via `baseUrl`, because the wire protocol is
the de-facto standard.

## Kinds

| Kind | Implements | Purpose |
| --- | --- | --- |
| `OpenAI.ChatModel` | `Ai.Model` | A chat model called for a complete answer, over `/chat/completions`. |
| `OpenAI.ChatModelStream` | `Ai.ModelStream` | The same, delivered as parts as they are generated. |
| `OpenAI.ResponsesModel` | `Ai.Model` | A chat model over `/v1/responses` — reasoning that survives a tool loop. |
| `OpenAI.ResponsesModelStream` | `Ai.ModelStream` | The same, streamed. |
| `OpenAI.ImageModel` | `Ai.ImageModel` | Generation, editing, inpainting and variations. |
| `OpenAI.EmbeddingModel` | `Embedding.Model` | Text vectors for search and indexing. |

Named by **role**, as every other backend names its kinds (`Postgres.Connection`,
`CacheRedis.Store`). The alias already says which vendor this is, so `OpenAI.OpenaiModel`
stuttered it. Where two kinds play the same role over different APIs, the API qualifies
the name — `ChatModel` and `ResponsesModel` are symmetric, rather than one of them being
the model and the other a variant of it.

## One module per system

Chat and embeddings used to be two modules (`ai-openai`, `embedding-openai`). They are
one now, so moderation, audio, batch and files arrive as further **kinds** here rather
than as a module apiece — and an app talking to OpenAI has one import and one version to
track rather than several that must agree.

Both old refs are published deprecated, naming this module as their replacement.
`telo upgrade` moves a pin within a ref and does not cross a rename, so a consumer edits
its `imports:` by hand once.

## Two APIs, two pairs of kinds

`/chat/completions` refuses a non-`none` reasoning effort alongside function tools:

```
400: Function tools with reasoning_effort are not supported for <model> in
/v1/chat/completions. To use function tools, use /v1/responses or set
reasoning_effort to 'none'.
```

An agent is nothing but tools, so on that API it runs with reasoning off. The
`Responses` pair is how a reasoning model drives a tool loop — the encrypted reasoning
comes back as the contract's `providerState`, is replayed on the next turn, and is tagged
with the model and dialect that produced it so a transcript moved elsewhere is dropped
rather than sent on.

Separate kinds rather than a dialect flag, because the two APIs share a vendor and little
else: `input` items against `messages`, `instructions` against a system role, flat tools
against nested ones, an `output` array against `choices`, named events against
`[DONE]`-terminated chunks. Under one kind, `reasoning` would be a field that is
sometimes a hard 400.

All four chat kinds send the model contract's `toolChoice` as `tool_choice`: `none`
keeps the tools in the request and forbids a new call, which is what an agent's
concluding call asks for.

Prefer the completions pair for everything else, and for every OpenAI-**compatible**
endpoint: Azure OpenAI, Ollama, vLLM, Groq and OpenRouter serve `/chat/completions`, and
almost none serve `/v1/responses`.

```yaml
kind: OpenAI.ResponsesModelStream
metadata: { name: reasoner }
model: gpt-5-nano
request: !ref openaiRequest
reasoning: { effort: low }
```

## Buffered and streaming are two kinds

`Ai.Model` and `Ai.ModelStream` are separate abstracts with one bound entry point each,
so a provider declares which it serves. `OpenAI.ChatModel` sends a genuinely non-streaming
request rather than collecting a stream — which is what keeps a buffered call working on
a deployment where streaming is disabled or separately gated.

An app using both declares both, sharing the model id and key. That restatement is the
residual cost of the split, and it buys the buffered path a validated contract: a live
value is exempt from validation, so one always-streaming abstract would take the check
away from the path most calls use.

```yaml
kind: OpenAI.ChatModel
metadata: { name: gpt }
model: gpt-4o-mini
request: !ref openaiRequest
---
kind: OpenAI.ChatModelStream
metadata: { name: gptStream }
model: gpt-4o-mini
request: !ref openaiRequest
```

## What a message can carry

Both chat APIs take text, images and documents; they differ in how a document may arrive.

| Part | Chat completions (`OpenAI.ChatModel`, `ChatModelStream`) | Responses (`OpenAI.ResponsesModel`, `ResponsesModelStream`) |
| --- | --- | --- |
| text | yes | yes |
| image by bytes (`data`) | yes — a `data:` URL | yes — a `data:` URL |
| image by `http:` / `https:` `uri` | yes — the string as written | yes — the string as written |
| file by bytes (`data`), with `name` (sent as its filename) | yes | yes |
| file by bytes with no `name` | `ERR_MODEL_CONTENT_UNSUPPORTED` | `ERR_MODEL_CONTENT_UNSUPPORTED` |
| file by `http:` / `https:` `uri` | `ERR_MODEL_CONTENT_UNSUPPORTED` | yes — the string as written |
| any other `uri` scheme (`file:`, `s3:`, …) | `ERR_MODEL_CONTENT_UNSUPPORTED`, `error.data.scheme` set | the same |
| audio, video | `ERR_MODEL_CONTENT_UNSUPPORTED` | `ERR_MODEL_CONTENT_UNSUPPORTED` |
| a part a model produces (`reasoning`, `citation`, `refusal`, `tool-call`) sent as input | `ERR_MODEL_CONTENT_UNSUPPORTED` | `ERR_MODEL_CONTENT_UNSUPPORTED` |

A part the API cannot carry is refused by the call, before anything is sent, as `ERR_MODEL_CONTENT_UNSUPPORTED` with `error.data.partType`, `error.data.mediaType` when the part has one, and `error.data.scheme` when the `uri`'s scheme is the reason. A `uri` is handed to the endpoint as written and never fetched.

A file by bytes needs `name`: both APIs take the bytes beside a filename, so one without is refused here (`error.data.partType: file`, no `scheme`) rather than sent; a file by `uri` on the responses kinds needs none. The provider gates on no media type. At OpenAI's own endpoint a file by bytes on chat completions is a PDF; any other type is the endpoint's to accept or refuse, and its refusal is the code its status and error name (usually `ERR_MODEL_REQUEST_REJECTED`).

Media a **tool** returned reaches the model on both APIs, by different routes: on the responses kinds it rides the tool's own output, in the tool's part order; on the chat kinds, whose tool message is text only, it rides a `user` message that follows the run of tool messages. Details per API: [chat](docs/chat-model.md#multimodal-content), [responses](docs/responses-model.md#content-parts).

`usage` carries `cachedPromptTokens` and `reasoningTokens` on all four chat kinds when the endpoint reports them, and leaves them absent when it does not.

**Prompt caching is automatic here.** OpenAI caches a repeated prompt prefix on its own, so a part's `cacheBreakpoint` is dropped and nothing is sent for it, on both APIs; a `system` written as text parts is sent as its text. What was read from the cache comes back as `cachedPromptTokens`; these endpoints report no cache-write count, so `cacheWritePromptTokens` stays absent.

## Streamed tool calls

Both stream kinds report a tool call's arguments as they are written — `tool-call-delta` parts carrying `toolCallId`, `toolName` and `delta` — ahead of the whole `tool-call`. `toolCallId` is the id the `tool-call` then carries, and a call's deltas join to its argument JSON. A fragment is held until the call's id and name are known, so an endpoint that names the call late still yields deltas under the right id; a call the endpoint never names gets a unique generated `call_<uuid>`, shared by its deltas and the call. Details per API: [chat](docs/chat-model.md), [responses](docs/responses-model.md#the-stream).

## Errors

The four language kinds raise **only the failures `Ai.Model` declares** — the same thirteen codes every provider raises, so a `catches:` written against them holds when the model behind it is swapped. Each kind restates the whole list. An `Ai` operation holding one passes the codes on, so a route's `catches:` names them whether its handler is the model or an operation over it. The codes, their `error.data` and which are worth another try: [`ai` → Catching a model's errors](../ai/README.md#catching-a-models-errors).

How this module arrives at a code:

| What happened | Code |
| --- | --- |
| The endpoint answered 401 or 403 | `ERR_MODEL_ACCESS_DENIED` |
| 402 | `ERR_MODEL_QUOTA_EXCEEDED` |
| 429 | `ERR_MODEL_RATE_LIMITED`, with `retryAfterSeconds` from `Retry-After` |
| 408 or 504; the request timed out | `ERR_MODEL_TIMEOUT` |
| 413 | `ERR_MODEL_CONTEXT_TOO_LONG` |
| any other 4xx; a status that is neither a success nor an error (an unfollowed redirect); a success the request's own `success:` rule refused | `ERR_MODEL_REQUEST_REJECTED` |
| The request could not be built | `ERR_MODEL_REQUEST_REJECTED`, no `status`, before anything is sent, the original kept as the error's cause |
| 5xx | `ERR_MODEL_UNAVAILABLE`, with `retryAfterSeconds` when the response named a wait |
| The connection was refused, the host did not resolve, the handshake failed | `ERR_MODEL_UNREACHABLE` |
| A 2xx body that is empty, not JSON, not an object, or carries no answer (`choices[0].message`; an `output` list); a malformed stream frame; a frame or line over 1 MiB; a body that breaks mid-stream; a stream that ends before its terminal event | `ERR_MODEL_RESPONSE_INVALID` |
| A member of a 2xx body or of a stream frame has the wrong shape — a list that must hold objects (`choices`, `tool_calls`, `output`, an item's `content` or `summary`) or an object (`message`, `delta`, a tool call's `function`, a frame's `item` or `response`) | `ERR_MODEL_RESPONSE_INVALID`, naming the member |
| The answer could not be read for any other reason | `ERR_MODEL_RESPONSE_INVALID`, the original kept as the error's cause |
| A content part this API cannot carry | `ERR_MODEL_CONTENT_UNSUPPORTED`, before anything is sent |
| Tool arguments that are not a JSON object, or that arrive as anything but JSON text | `ERR_MODEL_TOOL_ARGUMENTS_INVALID` |
| `request` is not a live `Http.Request` | `ERR_INVALID_REFERENCE` |
| The request's credential holds no material (`ERR_INVALID_CREDENTIAL`) | `ERR_MODEL_ACCESS_DENIED`, no `status` |
| Any other failure of the request — a `success:` / `retryOn:` rule that resolves to neither a list nor a boolean, a credential's own error, an uncoded error | `ERR_MODEL_REQUEST_REJECTED`, no `status`, the original kept as the error's cause |

**An answer is read as untrusted.** A text, id, name, token count or finish reason of the wrong type is read as absent and never copied into the result: text that is not text is no text, a count that is not a number is not reported, and a tool-call id that is not text is treated as one the endpoint never sent. A refused streamed response whose body breaks while its explanation is read still raises the status failure, with the break as its cause.

**The endpoint's own error object is read wherever it turns up** — a failed response's body, a 2xx body, a stream frame, a responses `error` / `response.failed` event, a run reported as failed — and it wins over any answer beside it. Its `code` and `type` are matched against these names first, and a match wins over the status:

| `error.code` or `error.type` | Code |
| --- | --- |
| `invalid_api_key`, `account_deactivated` | `ERR_MODEL_ACCESS_DENIED` |
| `insufficient_quota`, `billing_hard_limit_reached`, `billing_not_active` | `ERR_MODEL_QUOTA_EXCEEDED` |
| `rate_limit_exceeded` | `ERR_MODEL_RATE_LIMITED` |
| `context_length_exceeded` | `ERR_MODEL_CONTEXT_TOO_LONG` |
| `content_policy_violation`, `content_filter`, `moderation_blocked`, `image_content_policy_violation` | `ERR_MODEL_CONTENT_REFUSED` |
| `vector_store_timeout` | `ERR_MODEL_TIMEOUT` |
| `invalid_prompt`, `model_not_found`, `invalid_image`, `invalid_image_format`, `invalid_base64_image`, `invalid_image_url`, `invalid_image_mode`, `image_too_large`, `image_too_small`, `image_parse_error`, `image_file_too_large`, `unsupported_image_media_type`, `empty_image_file`, `failed_to_download_image`, `image_file_not_found` | `ERR_MODEL_REQUEST_REJECTED` |
| `server_error` | `ERR_MODEL_UNAVAILABLE` |

With no such name, the status rows above decide when a response carried the failure. Only when none did — an error inside a 2xx body or a stream — is the error's family read: `authentication_error` / `permission_error` → `ERR_MODEL_ACCESS_DENIED`, `rate_limit_error` → `ERR_MODEL_RATE_LIMITED`, `invalid_request_error` / `not_found_error` → `ERR_MODEL_REQUEST_REJECTED`, `api_error` / `overloaded_error` → `ERR_MODEL_UNAVAILABLE`. Anything still unnamed is `ERR_MODEL_UNAVAILABLE`. The vendor's name is never put in `error.data`; its message is in the error's message.

`status` is in `error.data` whenever a response carried the failure, whichever row decided the code, and absent for a failure reported inside a 2xx body or a stream. `retryAfterSeconds` comes only from the standard `Retry-After` header.

**`throwOnHttpError` changes nothing a caller can see but the wait.** With it set, `http-client` raises `ERR_HTTP_STATUS` before this module sees the response; that is classified from the status and body it carries, to the same codes — without `retryAfterSeconds`, since that error carries no headers.

**The kinds decode the answer themselves.** A buffered call asks the request for the body as text, a streamed one as a stream — never as parsed JSON — so what a response's `Content-Type` claims decides nothing. One consequence for a request handed to a model kind: its own `success:` / `retryOn:` rule sees `status` and `headers` as usual, but `body` is undecoded text on a buffered call and a stream on a streamed one. One limit: a buffered body that breaks mid-transfer is reported by the transport as a network failure, so it arrives as `ERR_MODEL_UNREACHABLE`.

A cancelled call is `ERR_INVOKE_CANCELLED`, never one of the model codes; a durable suspension and the kernel's contract errors (`ERR_INPUT_INVALID`, `ERR_OUTPUT_INVALID`, `ERR_CONTRACT_UNRESOLVABLE`, `ERR_SCHEMA_PROJECTION_UNRESOLVED`, `ERR_FUNCTION_FAILED`, `ERR_PREDICATE_NOT_BOOLEAN`) pass through unchanged.

`OpenAI.ImageModel` and `OpenAI.EmbeddingModel` are not invocables and declare no `throws:`; they go through the same boundary, so a failed call on either carries the same codes.

A failure **mid-stream rejects the iteration** rather than arriving as a data part — so it reaches
`catches:`, a throws union and a `try:` step, and a consumer that forgets to look for an
error part cannot silently truncate. Parts already emitted still reach the consumer, and
the shipped encoders frame the rejection with its code. A chat-completions stream is complete once a chunk carried a `finish_reason` or the `[DONE]` sentinel arrived; one that reaches `[DONE]` with no finish reason finishes `other`. A stream whose request is refused fails when it is first read, having read the refusal's explanation under a bound and released the response; a consumer that stops reading releases the transport.

## The account is an `Http.Client`

The model, image and embedding kinds carry **no credential of their own**. They reference an
`Http.Request`, whose client holds the base URL and the credential:

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
```

The key is declared once for every OpenAI kind in the app, and the `401`
re-acquire-and-retry comes with it rather than being re-implemented per provider. A
gateway, Azure or a self-hosted server is a different `baseUrl` on the client.

`OpenAI.ImageModel` goes through the same request, including image edit, inpaint and
variation, which send multipart/form-data: the form is framed as bytes and sent under the
boundary-bearing content type, a byte body like any other to `Http.Request` — and a
replayable one, so the 401 retry still applies.

## Secrets

Nothing on a model kind holds a key, so a reading cannot leak one. The credential's own
returned headers are marked `x-telo-sensitive`, so the material is `[redacted]` in trace
payloads and on the debug wire.

## Options

Model-level defaults are shallow-merged with per-call options; downstream wins. Keys are
native OpenAI request parameters (`temperature`, `max_tokens`, `top_p`, …), merged into
the request body verbatim.
