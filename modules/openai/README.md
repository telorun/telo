# OpenAI

Every OpenAI surface under one import: chat models (buffered and streaming), image
generation, and text embeddings. Calls the HTTP APIs directly — no vendor SDK.

The same controller serves every OpenAI-**compatible** endpoint (Azure OpenAI, gateways,
Ollama, vLLM, Groq, Together, OpenRouter, …) via `baseUrl`, because the wire protocol is
the de-facto standard.

## Kinds

| Kind | Implements | Purpose |
| --- | --- | --- |
| `OpenAI.Model` | `Ai.Model` | A chat model called for a complete answer. |
| `OpenAI.ModelStream` | `Ai.ModelStream` | The same, delivered as parts as they are generated. |
| `OpenAI.ImageModel` | `Ai.ImageModel` | Generation, editing, inpainting and variations. |
| `OpenAI.EmbeddingModel` | `Embedding.Model` | Text vectors for search and indexing. |

Named by **role**, as every other backend names its kinds (`Postgres.Connection`,
`CacheRedis.Store`). The alias already says which vendor this is, so `OpenAI.OpenaiModel`
stuttered it.

## One module per system

Chat and embeddings used to be two modules (`ai-openai`, `embedding-openai`). They are
one now, so moderation, audio, batch and files arrive as further **kinds** here rather
than as a module apiece — and an app talking to OpenAI has one import and one version to
track rather than several that must agree.

Both old refs are published deprecated, naming this module as their replacement.
`telo upgrade` moves a pin within a ref and does not cross a rename, so a consumer edits
its `imports:` by hand once.

## Buffered and streaming are two kinds

`Ai.Model` and `Ai.ModelStream` are separate abstracts with one bound entry point each,
so a provider declares which it serves. `OpenAI.Model` sends a genuinely non-streaming
request rather than collecting a stream — which is what keeps a buffered call working on
a deployment where streaming is disabled or separately gated.

An app using both declares both, sharing the model id and key. That restatement is the
residual cost of the split, and it buys the buffered path a validated contract: a live
value is exempt from validation, so one always-streaming abstract would take the check
away from the path most calls use.

```yaml
kind: OpenAI.Model
metadata: { name: gpt }
model: gpt-4o-mini
apiKey: !cel "secrets.openaiApiKey"
---
kind: OpenAI.ModelStream
metadata: { name: gptStream }
model: gpt-4o-mini
apiKey: !cel "secrets.openaiApiKey"
```

## Errors

A refused request raises the provider's own message, not just a status. A failure
**mid-stream rejects the iteration** rather than arriving as a data part — so it reaches
`catches:`, a throws union and a `try:` step, and a consumer that forgets to look for an
error part cannot silently truncate. Parts already emitted still reach the consumer, and
the shipped encoders frame the rejection with its code.

## Secrets

`snapshot()` redacts `apiKey`, so the key does not reach CEL or the debug stream.

## Options

Model-level defaults are shallow-merged with per-call options; downstream wins. Keys are
native OpenAI request parameters (`temperature`, `max_tokens`, `top_p`, …), merged into
the request body verbatim.
