---
description: "Embedding.Model: the backend-pluggable abstract every embedding backend implements. A Telo.Provider referenced by Embedding.Query / Embedding.Passage via x-telo-ref."
sidebar_label: Embedding.Model
---

# `Embedding.Model`

> Examples assume this module is imported under alias `Embedding`, `openai` under `OpenAI`, and `http-client` under `Http`. Substitute if you import under different names.

`Embedding.Model` is the abstract every embedding backend implements — a `Telo.Provider` representing a configured model, **not** an operation you invoke. [`Embedding.Query`](./embedding-query) and [`Embedding.Passage`](./embedding-passage) reference it via `x-telo-ref: Self.Model`; a concrete backend such as [`OpenAI.EmbeddingModel`](../../openai/docs/embedding-model.md) satisfies the ref by declaring `extends: Embedding.Model`.

## Prompt templates

Many retrieval checkpoints are **prompt-tuned**: they expect each text wrapped in a fixed instruction that differs by retrieval intent. embeddinggemma, E5 and BGE all do this. Feeding such a model raw text does not fail — it silently collapses the similarity spread, so every result lands in a narrow band and ranking degenerates into noise.

`queryPrompt` and `passagePrompt` declare those wrappers. Both are inherited by every backend, and both must contain the `{text}` placeholder:

```yaml
# A self-hosted checkpoint behind an OpenAI-compatible endpoint: the client
# carries the base URL and declares no credential, because the server needs none.
kind: Http.Client
metadata: { name: embedderClient }
baseUrl: http://localhost:11434/v1
---
kind: Http.Request
metadata: { name: embedderRequest }
client: !ref embedderClient
---
kind: OpenAI.EmbeddingModel
metadata:
  name: embedder
model: embeddinggemma-300m
request: !ref embedderRequest
queryPrompt: "task: search result | query: {text}"
passagePrompt: "title: none | text: {text}"
```

They live on the **model**, not on `Query` / `Passage`, because the wrapper is a property of the checkpoint. Declaring them once means the two sides cannot drift apart — indexing passages with one wrapper while embedding queries with another destroys recall, and nothing above the model layer can detect it.

Omit both for symmetric models (OpenAI's `text-embedding-3-*`, …), which take raw text.

> Changing either template invalidates every stored vector, exactly like changing the model: re-embed the whole index rather than leaving it mixed.

A template without `{text}` is rejected at boot — without the placeholder every input would embed to the same constant string.

## Implementing a backend

A backend controller implements the `EmbeddingModel` contract from `@telorun/embedding`:

```ts
import type { EmbedRequest, EmbedResult, EmbeddingModel, EmbeddingPrompts } from "@telorun/embedding";
import { applyEmbeddingPrompt, resolveEmbeddingPrompts } from "@telorun/embedding";

class MyModel implements EmbeddingModel {
  private readonly prompts: EmbeddingPrompts;

  constructor(private readonly resource: MyResource) {
    // Validate the declared templates once, at create() — a malformed template
    // then fails at boot instead of quietly poisoning an index.
    this.prompts = resolveEmbeddingPrompts(resource, `My.Model "${resource.metadata.name}"`);
  }

  async embed(request: EmbedRequest): Promise<EmbedResult> {
    // request.texts:   string[] (non-empty, in order)
    // request.intent:  "query" | "passage"  — map to the vendor's input-type param
    // request.options: per-call options merged over the model's own options
    const texts = applyEmbeddingPrompt(request.texts, request.intent, this.prompts);
    return { embeddings: /* number[][] */ [], dimensions: 0, usage: { promptTokens: 0, totalTokens: 0 } };
  }
}
```

Then declare the kind with `extends: Embedding.Model` and a `Telo.Provider` capability, pointing `controllers` at your package. The `queryPrompt` / `passagePrompt` fields come with the `extends` — you do not redeclare them in your schema. `applyEmbeddingPrompt` returns the texts unchanged when neither is set, so a backend for a symmetric model needs no branching. See `openai` for a reference implementation.

## Available backends

- [`OpenAI.EmbeddingModel`](../../openai/docs/embedding-model.md) — OpenAI `/embeddings` HTTP API, plus any OpenAI-compatible endpoint.
