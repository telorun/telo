# @telorun/embedding-openai

## 0.2.0

### Minor Changes

- df6a1b0: Add the `embedding` module — the `Embedding.Model` abstract plus the `Embedding.Query` / `Embedding.Passage` invocables that turn text into vectors — and `embedding-openai`, an OpenAI-compatible backend (`EmbeddingOpenai.Model`) speaking the `/embeddings` HTTP API directly.

  `Query` and `Passage` are the two sides of the asymmetric retrieval pair: each passes a fixed intent (`query` / `passage`) to the backend, mapped to the vendor's input-type parameter. Symmetric backends (OpenAI) accept and ignore it. Backends implement the `EmbeddingModel` contract from `@telorun/embedding` and extend `Embedding.Model`, mirroring the `cache` / `cache-memory` split.

### Patch Changes

- Updated dependencies [df6a1b0]
  - @telorun/embedding@0.2.0
