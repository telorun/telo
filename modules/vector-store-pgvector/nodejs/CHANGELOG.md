# @telorun/vector-store-pgvector

## 0.2.0

### Minor Changes

- fbe129e: Add the `@telorun/vector-store-pgvector` controller — a Postgres/pgvector backend for the `VectorStore.Store` abstract. Owns a configurable table inside an existing `Sql.Connection`, provisions the `vector` extension + HNSW index on init, and ranks via the pgvector `<=>` / `<#>` / `<->` operators with full `metadataFilter` support translated to JSONB predicates.
