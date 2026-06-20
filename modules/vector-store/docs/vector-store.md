---
description: "VectorStore: a backend-pluggable vector index — the Store abstract plus Record / Match / Removal invocables, with a MongoDB-style metadata filter shared across backends."
sidebar_label: VectorStore
---

# `VectorStore`

> Examples assume this module is imported under alias `VectorStore` and a backend under `VectorStoreMemory`. Substitute if you import under different names.

`VectorStore` is the backend-pluggable vector index for Telo. [`VectorStore.Store`](#vectorstorestore) is the abstract every backend implements — a `Telo.Provider` representing a configured index, **not** an operation you invoke. [`VectorStore.Record`](#vectorstorerecord), [`VectorStore.Match`](#vectorstorematch), and [`VectorStore.Removal`](#vectorstoreremoval) operate against any store via `x-telo-ref: "std/vector-store#Store"`. A concrete backend such as [`VectorStoreMemory.Store`](../../vector-store-memory/README.md) satisfies the ref by declaring `extends: VectorStore.Store`.

## `VectorStore.Store`

The abstract index contract. Backend config (metric, dimensions, capacity) lives on the concrete backend, not here — exactly as `Cache.Store` carries nothing and `cache-memory` carries its own config. The store is authoritative for dimension enforcement.

## `VectorStore.Record`

Upsert vectors. Batch-first — the same kind handles one or many.

- **Input**: `{ items: [{ id: string, vector: number[], metadata?: object }] }`
- **Output**: `{ ids: string[] }` (ids written, in input order)
- **Config**: `store` (`!ref` to a `VectorStore.Store`)

```yaml
kind: VectorStore.Record
metadata: { name: Write }
store: !ref Index
```

## `VectorStore.Match`

Nearest-neighbour query. Vector-only: embed the query text first (e.g. with [`Embedding.Query`](../../embedding/docs/embedding-query)), keeping this op single-responsibility and free of an embedder dependency.

- **Input**: `{ vector: number[], metadataFilter?: Filter }`
- **Output**: `{ matches: [{ id, score, metadata?, vector? }] }` (higher `score` = closer)
- **Config**: `store`, `topK` (default 10), `includeVectors` (default false)

```yaml
kind: VectorStore.Match
metadata: { name: Search }
store: !ref Index
topK: 5
```

## `VectorStore.Removal`

Delete by id list and/or metadata filter (at least one required).

- **Input**: `{ ids?: string[], metadataFilter?: Filter }`
- **Output**: `{ removed: integer }`
- **Config**: `store`

## Metadata filter

`metadataFilter` constrains records by their metadata, orthogonal to vector similarity (`vector` + `topK` + `metric`). It is a MongoDB-style operator subset — the shape Pinecone and Chroma expose and the query-document form the official MongoDB drivers use in Node, Rust, and Go, so backends in any language have idiomatic tooling.

| Operator | Meaning |
| --- | --- |
| bare scalar | implicit `$eq` |
| `$eq` / `$ne` | equals / not-equals |
| `$gt` / `$gte` / `$lt` / `$lte` | numeric comparison |
| `$in` / `$nin` | membership |
| `$and` / `$or` | boolean groups (arrays of filters) |
| `$not` | negate a filter |

Top-level keys are ANDed.

```yaml
metadataFilter:
  status: published
  score: { $gte: 0.5 }
  $or:
    - { lang: en }
    - { lang: fr }
```

### Portability invariants

These are what make the shared abstract honest:

- The operator set is capped at the **intersection** of what all intended backends can push down natively. Flat metadata keys only — no dotted/nested paths, regex, or `$exists` in v1, since those don't translate uniformly across pgvector / qdrant / weaviate.
- A backend that receives an operator it cannot translate **throws** a structured error — it never silently ignores it, and never falls back to in-memory post-filtering (which would diverge from another backend on `topK` / pagination).
- Each backend module documents its operator → native mapping table.

The grammar is declared once as a `Type.JsonSchema` named `MetadataFilter` and referenced by both `Match` and `Removal` via `$ref: "telo://Self/MetadataFilter"`, so the single definition stays the source of truth (see the [`type` module](../../type/README.md#referencing-a-type-from-another-schema-ref)).

## Index then retrieve

```yaml
kind: Run.Sequence
metadata: { name: indexDocument }
steps:
  - name: embedPassage
    invoke: !ref passageVector       # Embedding.Passage
    inputs: { input: !cel variables.document }
  - name: store
    invoke: !ref Write
    inputs:
      items:
        - id: !cel variables.docId
          vector: !cel steps.embedPassage.result.embeddings[0]
          metadata: { text: !cel variables.document }
  - name: embedQuery
    invoke: !ref queryVector         # Embedding.Query
    inputs: { input: "What is Telo?" }
  - name: search
    invoke: !ref Search
    inputs: { vector: !cel steps.embedQuery.result.embeddings[0] }
# → steps.search.result.matches[0].id / .score / .metadata
```

## Available backends

- [`VectorStoreMemory.Store`](../../vector-store-memory/README.md) — in-process cosine / dot / euclidean index for development and tests.
