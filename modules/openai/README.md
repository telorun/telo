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
| file by bytes with no `name` | `ERR_CONTENT_UNSUPPORTED` | `ERR_CONTENT_UNSUPPORTED` |
| file by `http:` / `https:` `uri` | `ERR_CONTENT_UNSUPPORTED` | yes — the string as written |
| any other `uri` scheme (`file:`, `s3:`, …) | `ERR_CONTENT_UNSUPPORTED`, `error.data.scheme` set | the same |
| audio, video | `ERR_CONTENT_UNSUPPORTED` | `ERR_CONTENT_UNSUPPORTED` |
| a part a model produces (`reasoning`, `citation`, `refusal`, `tool-call`) sent as input | `ERR_CONTENT_UNSUPPORTED` | `ERR_CONTENT_UNSUPPORTED` |

A part the API cannot carry is refused by the call, before anything is sent, as `ERR_CONTENT_UNSUPPORTED` with `error.data.partType` (and `error.data.scheme` when the `uri`'s scheme is the reason). A `uri` is handed to the endpoint as written and never fetched.

A file by bytes needs `name`: both APIs take the bytes beside a filename, so one without is refused here (`error.data.partType: file`, no `scheme`) rather than sent; a file by `uri` on the responses kinds needs none. The provider gates on no media type. At OpenAI's own endpoint a file by bytes on chat completions is a PDF; any other type is the endpoint's to accept or refuse, and a refusal is `ERR_OPENAI_REQUEST_FAILED`.

Media a **tool** returned reaches the model on both APIs, by different routes: on the responses kinds it rides the tool's own output, in the tool's part order; on the chat kinds, whose tool message is text only, it rides a `user` message that follows the run of tool messages. Details per API: [chat](docs/chat-model.md#multimodal-content), [responses](docs/responses-model.md#content-parts).

`usage` carries `cachedPromptTokens` and `reasoningTokens` on all four chat kinds when the endpoint reports them, and leaves them absent when it does not.

## Streamed tool calls

Both stream kinds report a tool call's arguments as they are written — `tool-call-delta` parts carrying `toolCallId`, `toolName` and `delta` — ahead of the whole `tool-call`. `toolCallId` is the id the `tool-call` then carries, and a call's deltas join to its argument JSON. A fragment is held until the call's id and name are known, so an endpoint that names the call late still yields deltas under the right id; a call the endpoint never names gets a unique generated `call_<uuid>`, shared by its deltas and the call. Details per API: [chat](docs/chat-model.md), [responses](docs/responses-model.md#the-stream).

## Errors

The four chat kinds declare `ERR_OPENAI_REQUEST_FAILED`, `ERR_CONTENT_UNSUPPORTED`, `ERR_OPENAI_INVALID_TOOL_ARGUMENTS` and `ERR_INVALID_REFERENCE`. An `Ai` operation holding one passes them on, so a route's `catches:` names them whether its handler is the model or an operation over it.

A refused request raises the provider's own message, not just a status. A failure
**mid-stream rejects the iteration** rather than arriving as a data part — so it reaches
`catches:`, a throws union and a `try:` step, and a consumer that forgets to look for an
error part cannot silently truncate. Parts already emitted still reach the consumer, and
the shipped encoders frame the rejection with its code.

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
