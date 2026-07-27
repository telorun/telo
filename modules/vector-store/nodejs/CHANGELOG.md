# @telorun/vector-store

## 0.3.0

### Minor Changes

- 942c176: Resolve provider-shaped `!ref` slots through `ctx.resolveRef` instead of a
  per-module copy of the same two-branch logic.

  The removed wrappers (`resolveCacheStore`, `resolveShellHost`,
  `resolveVectorStore`, `resolveEmbeddingModel`, `resolveJournal`) were one-line
  shims; call sites now pass the module's own type guard and the slot's `x-telo-ref`
  contract, so a mis-wire names the owning resource and what the slot wanted —
  `` Cache.Entry "page": 'store' … did not resolve to a resource satisfying
`std/cache#Store`  ``. Each module still
  exports its guard (`isCacheStore`, `isShellHost`, `isVectorStore`,
  `isEmbeddingModel`, `isJournalStore`, `isSqlConnection`) for consumers that
  resolve the slot themselves; `isJournalStore` is now duck-typed rather than
  `instanceof`, so it survives two copies of the package in one process.

  `resolveSqlConnection` stays — it encodes the optional-slot rule that lets a
  `Sql.Query` fall back to its `transaction` — and now takes a `describe` argument,
  so its six call sites report the owning resource instead of a bare `Sql:` prefix.
  Ref-typed manifest fields use the SDK's `KindRef<T>` rather than a hand-rolled
  `{ name, alias }`.

## 0.2.0

### Minor Changes

- d7fda97: Add the `vector-store` module — the `VectorStore.Store` abstract (a backend-pluggable vector index) plus the `Record` / `Match` / `Removal` invocables that upsert, query, and delete vectors against any store, mirroring the `cache` / `cache-memory` family.

  - `vector-store` core declares the abstract and the three operations, and exports the `VectorStoreHandle` contract (`@telorun/vector-store` barrel: `VectorStoreHandle`, `resolveVectorStore`, `MetadataFilter`, …) so backends and downstream modules can build/reuse stores.
  - `Match` is vector-only — the caller embeds the query first (e.g. `Embedding.Query`), keeping the store free of an embedder dependency.
  - `Match` / `Removal` take a MongoDB-style `metadataFilter` (`$eq`/`$ne`/`$gt`/`$gte`/`$lt`/`$lte`/`$in`/`$nin`/`$and`/`$or`/`$not`); every backend implements the same subset or throws on an operator it cannot translate.
  - `vector-store-memory` (`VectorStoreMemory.Store`) provides an in-process cosine / dot / euclidean index with dimension enforcement and FIFO eviction, the first concrete backend (`extends VectorStore.Store`).
