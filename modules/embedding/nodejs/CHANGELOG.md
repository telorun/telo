# @telorun/embedding

## 0.3.0

### Minor Changes

- bd4f3ac: Add `queryPrompt` / `passagePrompt` to the `Embedding.Model` abstract.

  Prompt-tuned retrieval checkpoints (embeddinggemma, E5, BGE) expect each text
  wrapped in a fixed instruction that differs by retrieval intent. Feeding them
  raw text does not fail — it collapses the similarity spread, so ranking
  degenerates into noise. The templates are declared on the model, so the query
  and passage sides cannot drift apart, and backends apply them through the
  shared `applyEmbeddingPrompt` / `resolveEmbeddingPrompts` helpers. A template
  missing the `{text}` placeholder is rejected at boot.

  The kernel now stamps the inheritance-resolved author schema onto a definition
  that `extends` another kind, reusing the analyzer's `effectiveAuthorSchema`.
  Previously the analyzer accepted a field inherited from an `extends` parent
  while the kernel — validating against the child's own schema only — rejected
  the same resource at `create()`.

## 0.2.0

### Minor Changes

- df6a1b0: Add the `embedding` module — the `Embedding.Model` abstract plus the `Embedding.Query` / `Embedding.Passage` invocables that turn text into vectors — and `embedding-openai`, an OpenAI-compatible backend (`EmbeddingOpenai.Model`) speaking the `/embeddings` HTTP API directly.

  `Query` and `Passage` are the two sides of the asymmetric retrieval pair: each passes a fixed intent (`query` / `passage`) to the backend, mapped to the vendor's input-type parameter. Symmetric backends (OpenAI) accept and ignore it. Backends implement the `EmbeddingModel` contract from `@telorun/embedding` and extend `Embedding.Model`, mirroring the `cache` / `cache-memory` split.
