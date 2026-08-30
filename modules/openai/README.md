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

## Errors

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
