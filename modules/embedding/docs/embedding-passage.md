---
description: "Embedding.Passage: embeds stored passages (index-side chunks) into vectors against any Embedding.Model. Batch-first input, passage retrieval intent, output shape."
sidebar_label: Embedding.Passage
---

# `Embedding.Passage`

> Examples assume this module is imported under alias `Embedding` and an OpenAI backend under `EmbeddingOpenai`. Substitute if you import under different names.

`Embedding.Passage` embeds **stored passages** — the chunks you index — into vectors against any [`Embedding.Model`](./embedding-model). It is the index-side half of the asymmetric pair; [`Embedding.Query`](./embedding-query) is the retrieval-side half. The controller passes the retrieval intent `passage` to the backend (mapped to the vendor's `search_document` / `RETRIEVAL_DOCUMENT` parameter); symmetric backends ignore it.

Structurally identical to `Embedding.Query` — same schema, input, and output; only the baked-in intent differs.

## Schema

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `model` | ref → `std/embedding#Model` | yes | The embedding model to call. |
| `options` | object | no | Provider-specific per-call options. |

## Input

```yaml
input: string | string[]   # a single passage, or a batch; non-empty
```

## Output

```yaml
embeddings: number[][]     # one vector per input, in input order
dimensions: integer
usage: { promptTokens: integer, totalTokens: integer }
```

## Example

```yaml
kind: Embedding.Passage
metadata: { name: passageVector }
model: !ref textEmbedding
---
kind: Run.Sequence
metadata: { name: index }
steps:
  - name: embedPassage
    invoke: !ref passageVector
    inputs: { input: !cel variables.document }
  # → steps.embedPassage.result.embeddings[0] feeds VectorStore.Record
```
