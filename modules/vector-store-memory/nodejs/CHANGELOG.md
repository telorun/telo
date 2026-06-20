# @telorun/vector-store-memory

## 0.2.0

### Minor Changes

- d7fda97: Add the `vector-store` module — the `VectorStore.Store` abstract (a backend-pluggable vector index) plus the `Record` / `Match` / `Removal` invocables that upsert, query, and delete vectors against any store, mirroring the `cache` / `cache-memory` family.

  - `vector-store` core declares the abstract and the three operations, and exports the `VectorStoreHandle` contract (`@telorun/vector-store` barrel: `VectorStoreHandle`, `resolveVectorStore`, `MetadataFilter`, …) so backends and downstream modules can build/reuse stores.
  - `Match` is vector-only — the caller embeds the query first (e.g. `Embedding.Query`), keeping the store free of an embedder dependency.
  - `Match` / `Removal` take a MongoDB-style `metadataFilter` (`$eq`/`$ne`/`$gt`/`$gte`/`$lt`/`$lte`/`$in`/`$nin`/`$and`/`$or`/`$not`); every backend implements the same subset or throws on an operator it cannot translate.
  - `vector-store-memory` (`VectorStoreMemory.Store`) provides an in-process cosine / dot / euclidean index with dimension enforcement and FIFO eviction, the first concrete backend (`extends VectorStore.Store`).

### Patch Changes

- Updated dependencies [d7fda97]
  - @telorun/vector-store@0.2.0
