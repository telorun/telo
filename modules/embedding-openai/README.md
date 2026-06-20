# Embedding OpenAI

`EmbeddingOpenai.Model` — an OpenAI-compatible backend for the [`embedding`](../embedding/README.md) module's `Embedding.Model` abstract. It speaks the OpenAI `/embeddings` HTTP API directly (no vendor SDK), so the same controller serves OpenAI plus every OpenAI-compatible endpoint (Azure OpenAI, vLLM, …) via `baseUrl`.

OpenAI embeddings are **symmetric** — there is no query/passage wire parameter — so the retrieval intent from `Embedding.Query` / `Embedding.Passage` is accepted and ignored; both produce identical vectors.

## Usage

```yaml
imports:
  Embedding: std/embedding@0.1.0
  EmbeddingOpenai: std/embedding-openai@0.1.0
---
kind: EmbeddingOpenai.Model
metadata: { name: textEmbedding }
model: text-embedding-3-small
apiKey: !cel secrets.openaiApiKey
dimensions: 1536
---
kind: Embedding.Passage
metadata: { name: passageVector }
model: !ref textEmbedding
```

## Schema

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `model` | string | yes | OpenAI embedding model id (e.g. `text-embedding-3-small`). |
| `apiKey` | string | yes | Secret reference; typically `${{ secrets.openaiApiKey }}`. |
| `baseUrl` | string | no | Override the API base URL (Azure OpenAI, gateways). |
| `dimensions` | integer | no | Output dimensionality; v3 models support truncation. |
| `options` | object | no | Extra request params merged into the body; per-call options win. |

`apiKey` is redacted from snapshots.
