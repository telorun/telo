---
description: "Embedding.Model: the backend-pluggable abstract every embedding backend implements. A Telo.Provider referenced by Embedding.Query / Embedding.Passage via x-telo-ref."
sidebar_label: Embedding.Model
---

# `Embedding.Model`

> Examples assume this module is imported under alias `Embedding`. Substitute if you import under a different name.

`Embedding.Model` is the abstract every embedding backend implements — a `Telo.Provider` representing a configured model, **not** an operation you invoke. [`Embedding.Query`](./embedding-query) and [`Embedding.Passage`](./embedding-passage) reference it via `x-telo-ref: "std/embedding#Model"`; a concrete backend such as [`EmbeddingOpenai.Model`](../../embedding-openai/docs/embedding-openai-model) satisfies the ref by declaring `extends: Embedding.Model`.

## Implementing a backend

A backend controller implements the `EmbeddingModel` contract from `@telorun/embedding`:

```ts
import type { EmbedRequest, EmbedResult, EmbeddingModel } from "@telorun/embedding";

class MyModel implements EmbeddingModel {
  async embed(request: EmbedRequest): Promise<EmbedResult> {
    // request.texts:   string[] (non-empty, in order)
    // request.intent:  "query" | "passage"  — map to the vendor's input-type param
    // request.options: per-call options merged over the model's own options
    return { embeddings: /* number[][] */ [], dimensions: 0, usage: { promptTokens: 0, totalTokens: 0 } };
  }
}
```

Then declare the kind with `extends: Embedding.Model` and a `Telo.Provider` capability, pointing `controllers` at your package. See `embedding-openai` for a reference implementation.

## Available backends

- [`EmbeddingOpenai.Model`](../../embedding-openai/docs/embedding-openai-model) — OpenAI `/embeddings` HTTP API (symmetric; intent ignored).
