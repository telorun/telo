# Vector Store Memory

`VectorStoreMemory.Store` — an in-process implementation of the [`VectorStore.Store`](../vector-store/README.md) abstract. Cosine / dot / euclidean similarity over a `Map`; zero external dependencies. Ideal for development, tests, and small single-instance indexes.

## Why use this

- **Zero setup** — vectors live in a `Map` in the process; nothing to run.
- **Three metrics** — `cosine` (default), `dot`, or `euclidean`. Higher `score` is always better (euclidean returns the negated distance).
- **Authoritative dimensions** — set `dimensions` and inserts / queries of any other length are rejected, catching mismatched embeddings early.
- **Bounded** — optional `maxEntries` caps memory; the oldest-written entry is evicted (FIFO) on overflow.

## Kinds

| Kind | Capability | Purpose |
| --- | --- | --- |
| `VectorStoreMemory.Store` | Provider | In-process vector index; satisfies `VectorStore.Store`. |

## Config

| Field | Default | Purpose |
| --- | --- | --- |
| `metric` | `cosine` | Similarity metric (`cosine` / `dot` / `euclidean`). |
| `dimensions` | — | Expected vector length; mismatches are rejected. |
| `maxEntries` | unbounded | FIFO cap on retained entries. |

## Metadata filter mapping

`VectorStoreMemory.Store` evaluates the shared [`metadataFilter`](../vector-store/README.md#metadata-filter) grammar in-process — each operator maps to a direct JavaScript comparison:

| Operator | Evaluation |
| --- | --- |
| `$eq` / `$ne` | `===` / `!==` |
| `$gt` / `$gte` / `$lt` / `$lte` | numeric `>` / `>=` / `<` / `<=` |
| `$in` / `$nin` | `Array.includes` |
| `$and` / `$or` / `$not` | recursive compose |

An unsupported operator throws rather than silently matching.

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
maxEntries: 100000
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
