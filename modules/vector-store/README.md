# Vector Store

The backend-pluggable vector index abstract for Telo. `VectorStore.Store` is the contract every backend implements; `VectorStore.Record`, `VectorStore.Match`, and `VectorStore.Removal` upsert, query, and delete vectors against any store. Backends ship as their own modules — `vector-store-memory` (`VectorStoreMemory.Store`) today, `vector-store-pgvector` / `vector-store-qdrant` later — mirroring the `cache` / `cache-memory` family.

## Why use this

- **Backend-pluggable** — write `!ref` to a `VectorStore.Store`; swap memory ↔ pgvector ↔ qdrant without touching consumers.
- **Single-responsibility** — `Match` is vector-only: embed the query first (e.g. `Embedding.Query`), then search. The store never depends on an embedder.
- **Portable metadata filters** — `Match` / `Removal` take a MongoDB-style `metadataFilter`; every backend implements the same operator subset identically.

## Kinds

| Kind | Capability | Purpose |
| --- | --- | --- |
| `VectorStore.Store` | Provider (abstract) | The backing index contract; satisfied by a concrete backend. |
| `VectorStore.Record` | Invocable | Upsert vectors `{ id, vector, metadata }` (batch-first). |
| `VectorStore.Match` | Invocable | Nearest-neighbour query → `{ matches: [{ id, score, metadata?, vector? }] }`. |
| `VectorStore.Removal` | Invocable | Delete by `ids` and/or `metadataFilter`. |

## Metadata filter

`metadataFilter` constrains records by their metadata, orthogonal to vector similarity. It is a MongoDB-style operator subset — the shape Pinecone and Chroma expose and the query-document form the official MongoDB drivers use in Node, Rust, and Go:

- Comparison: `$eq` (implicit for a bare scalar), `$ne`, `$gt`, `$gte`, `$lt`, `$lte`
- Membership: `$in`, `$nin`
- Logical: `$and`, `$or`, `$not`
- Top-level keys are ANDed.

```yaml
metadataFilter:
  status: published          # implicit $eq
  score: { $gte: 0.5 }
  $or:
    - { lang: en }
    - { lang: fr }
```

### Portability invariants

- Operators are capped at the **intersection** of what all intended backends can push down natively (flat keys only — no dotted paths, regex, or `$exists` in v1).
- A backend that cannot translate an operator **throws** — it never silently ignores it or post-filters in memory, so the same manifest yields the same result on every backend.
- Each backend documents its operator → native mapping.

## Example

```yaml
imports:
  VectorStore: std/vector-store@latest
  VectorStoreMemory: std/vector-store-memory@latest
---
kind: VectorStoreMemory.Store
metadata: { name: Index }
metric: cosine
dimensions: 1536
---
kind: VectorStore.Record
metadata: { name: Write }
store: !ref Index
---
kind: VectorStore.Match
metadata: { name: Search }
store: !ref Index
topK: 5
```

Invoke `Write` with `{ items: [{ id, vector, metadata }] }`; invoke `Search` with `{ vector, metadataFilter? }`.

## Implementing a backend

A backend controller implements the `VectorStoreHandle` contract from `@telorun/vector-store`:

```ts
import type { VectorStoreHandle } from "@telorun/vector-store";

class MyStore implements VectorStoreHandle {
  readonly dimensions?: number;             // exposed for introspection
  async upsert(items) { /* reject wrong-length vectors; persist */ return { ids: [] }; }
  async query(vector, opts) { /* rank by metric; apply opts.metadataFilter */ return { matches: [] }; }
  async delete(opts) { /* by ids and/or metadataFilter */ return { removed: 0 }; }
  async provide() { return this; }
}
```

Declare the kind with `extends: VectorStore.Store` and a `Telo.Provider` capability, pointing `controllers` at your package. See `vector-store-memory` for a reference implementation.
