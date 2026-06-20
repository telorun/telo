---
description: "Embedding.Query: embeds search queries into vectors against any Embedding.Model. Batch-first input, query retrieval intent, output shape and usage."
sidebar_label: Embedding.Query
---

# `Embedding.Query`

> Examples assume this module is imported under alias `Embedding` and an OpenAI backend under `EmbeddingOpenai`. Substitute if you import under different names.

`Embedding.Query` embeds **search queries** into vectors against any [`Embedding.Model`](./embedding-model). It is the retrieval-side half of the asymmetric pair; [`Embedding.Passage`](./embedding-passage) is the index-side half. The controller passes the retrieval intent `query` to the backend (mapped to the vendor's `search_query` / `RETRIEVAL_QUERY` parameter); symmetric backends ignore it.

## Schema

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `model` | ref → `std/embedding#Model` | yes | The embedding model to call. |
| `options` | object | no | Provider-specific per-call options. |

## Input

```yaml
input: string | string[]   # a single query, or a batch; non-empty
```

Batch-first: a single string is the one-element case.

## Output

```yaml
embeddings: number[][]     # one vector per input, in input order
dimensions: integer
usage: { promptTokens: integer, totalTokens: integer }
```

## Example

```yaml
kind: Embedding.Query
metadata: { name: queryVector }
model: !ref textEmbedding
---
kind: Run.Sequence
metadata: { name: search }
steps:
  - name: embedQuery
    invoke: !ref queryVector
    inputs: { input: "What is Telo?" }
  # → steps.embedQuery.result.embeddings[0] feeds VectorStore.Match
```
