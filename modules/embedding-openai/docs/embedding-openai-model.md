---
description: "EmbeddingOpenai.Model: OpenAI-compatible backend for Embedding.Model. Calls the OpenAI /embeddings HTTP API directly (no vendor SDK). Schema, dimensions, symmetric intent, redaction."
sidebar_label: EmbeddingOpenai.Model
---

# `EmbeddingOpenai.Model`

> Examples assume the `embedding` module is imported under alias `Embedding` and this module under `EmbeddingOpenai`. Substitute if you import under different names.

`EmbeddingOpenai.Model` is an OpenAI-compatible backend for the [`Embedding.Model`](../../embedding/docs/embedding-model) abstract. It calls the OpenAI `/embeddings` HTTP API directly — no vendor SDK — so the same controller serves OpenAI plus every OpenAI-compatible endpoint via `baseUrl`.

OpenAI embeddings are **symmetric**: there is no query/passage wire parameter, so the retrieval intent from `Embedding.Query` / `Embedding.Passage` is accepted and ignored. Both produce identical vectors for the same text.

## Schema

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `model` | string | yes | OpenAI embedding model id (e.g. `text-embedding-3-small`, `text-embedding-3-large`). |
| `apiKey` | string | yes | API key. Compile-time evaluated; typically `${{ secrets.openaiApiKey }}`. |
| `baseUrl` | string | no | Override the base URL (default `https://api.openai.com/v1`). |
| `dimensions` | integer | no | Output dimensionality. v3 models support truncating to fewer dimensions. |
| `options` | object | no | Extra params merged into the request body; per-call `options` win. |

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

## Options merging

The request body is built as: `{ model, input, dimensions? }` ← the model's `options` ← the per-call `options` passed on `Embedding.Query` / `Embedding.Passage`. Shallow merge; the caller wins.
