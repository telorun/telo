# Embedding

The backend-pluggable text-embedding abstract for Telo. `Embedding.Model` is the contract every backend implements; `Embedding.Query` and `Embedding.Passage` turn text into vectors against any model. Backends ship as their own modules — `embedding-openai` (`EmbeddingOpenai.Model`) — mirroring the `cache` / `cache-memory` family.

## Why two operations

Asymmetric retrieval models embed a search **query** differently from a stored **passage** (Cohere `search_query` / `search_document`, Gemini `RETRIEVAL_QUERY` / `RETRIEVAL_DOCUMENT`, Voyage `query` / `document`). The same text embedded as a query versus a passage yields different vectors, and store-time versus query-time must signal intent.

`Embedding.Query` and `Embedding.Passage` make that intent **structural** — one kind per side of a retrieval match. They share an identical input/output shape; only the intent the controller passes to the backend differs. Symmetric models (OpenAI) ignore the distinction and return identical vectors for both. `Query` / `Passage` is the canonical IR pairing (DPR, E5, BEIR), and `Passage` is truthful about the chunk-sized unit actually embedded in RAG.

## Kinds

| Kind | Capability | Purpose |
| --- | --- | --- |
| `Embedding.Model` | `Telo.Provider` | The abstract model. A concrete backend (`EmbeddingOpenai.Model`) satisfies it. |
| `Embedding.Query` | `Telo.Invocable` | Embeds search queries. |
| `Embedding.Passage` | `Telo.Invocable` | Embeds stored passages (the chunks you index). |

`Query` and `Passage` take `{ input: string | string[] }` (batch-first — a single string is the one-element case) and return `{ embeddings: number[][], dimensions, usage }`, one vector per input in input order.

## Usage

> Examples assume this module is imported under alias `Embedding` and an OpenAI backend under `EmbeddingOpenai`.

```yaml
kind: EmbeddingOpenai.Model
metadata: { name: textEmbedding }
model: text-embedding-3-small
apiKey: !cel secrets.openaiApiKey
dimensions: 1536
---
kind: Embedding.Passage
metadata: { name: passageVector }
model: !ref textEmbedding
---
kind: Embedding.Query
metadata: { name: queryVector }
model: !ref textEmbedding
```

Index a chunk, then retrieve — embed the stored text with `Embedding.Passage`, the search text with `Embedding.Query`:

```yaml
kind: Run.Sequence
metadata: { name: index }
steps:
  - name: embed
    invoke: !ref passageVector
    inputs: { input: !cel variables.document }
  # → steps.embed.result.embeddings[0] is the passage vector
```

Wire the resulting vector into a vector store (`VectorStore.Record` for indexing, `VectorStore.Match` for search).

## Backends

| Module | Kind | Notes |
| --- | --- | --- |
| `embedding-openai` | `EmbeddingOpenai.Model` | OpenAI `/embeddings` HTTP API; symmetric (intent ignored). |

To add a backend, implement the `EmbeddingModel` contract from `@telorun/embedding` and declare a `Telo.Definition` with `extends: Embedding.Model`.
