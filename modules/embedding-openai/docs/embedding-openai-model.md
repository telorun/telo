---
description: "EmbeddingOpenai.Model: OpenAI-compatible backend for Embedding.Model. Calls the OpenAI /embeddings HTTP API directly (no vendor SDK). Schema, dimensions, symmetric intent, redaction."
sidebar_label: EmbeddingOpenai.Model
---

# `EmbeddingOpenai.Model`

> Examples assume the `embedding` module is imported under alias `Embedding` and this module under `EmbeddingOpenai`. Substitute if you import under different names.

`EmbeddingOpenai.Model` is an OpenAI-compatible backend for the [`Embedding.Model`](../../embedding/docs/embedding-model) abstract. It calls the OpenAI `/embeddings` HTTP API directly — no vendor SDK — so the same controller serves OpenAI plus every OpenAI-compatible endpoint via `baseUrl`.

OpenAI's own embedding models are **symmetric**: there is no query/passage wire parameter, so with no prompt templates configured the retrieval intent from `Embedding.Query` / `Embedding.Passage` has no effect and both produce identical vectors for the same text.

Self-hosted checkpoints served over the same API are frequently **not** symmetric — embeddinggemma, E5 and BGE encode the intent as a text prefix. Set `queryPrompt` / `passagePrompt` (inherited from `Embedding.Model`) to express that, and the intent reaches the model without this controller needing to know which checkpoint is behind the endpoint. See [prompt templates](../../embedding/docs/embedding-model#prompt-templates).

## Schema

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `model` | string | yes | OpenAI embedding model id (e.g. `text-embedding-3-small`, `text-embedding-3-large`). |
| `apiKey` | string | yes | API key. Compile-time evaluated; typically `${{ secrets.openaiApiKey }}`. |
| `baseUrl` | string | no | Override the base URL (default `https://api.openai.com/v1`). |
| `dimensions` | integer | no | Output dimensionality. v3 models support truncating to fewer dimensions. |
| `options` | object | no | Extra params merged into the request body; per-call `options` win. |
| `queryPrompt` | string | no | Inherited from `Embedding.Model`. Template wrapping each `query`-intent text; must contain `{text}`. |
| `passagePrompt` | string | no | Inherited from `Embedding.Model`. Template wrapping each `passage`-intent text; must contain `{text}`. |

`apiKey` is replaced with `[redacted]` in resource snapshots.

## Example

```yaml
kind: EmbeddingOpenai.Model
metadata: { name: textEmbedding }
model: text-embedding-3-small
apiKey: !cel secrets.openaiApiKey
dimensions: 1536
---
kind: Embedding.Query
metadata: { name: queryVector }
model: !ref textEmbedding
```

Pointing at a self-hosted prompt-tuned checkpoint instead:

```yaml
kind: EmbeddingOpenai.Model
metadata: { name: gemma }
model: embeddinggemma-300m
apiKey: unused
baseUrl: http://embedder/v1
queryPrompt: "task: search result | query: {text}"
passagePrompt: "title: none | text: {text}"
```

## Options merging

The request body is built as: `{ model, input, dimensions? }` ← the model's `options` ← the per-call `options` passed on `Embedding.Query` / `Embedding.Passage`. Shallow merge; the caller wins.
