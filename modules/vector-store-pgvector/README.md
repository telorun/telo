# Vector Store pgvector

`VectorStorePgvector.Store` — a Postgres/[pgvector](https://github.com/pgvector/pgvector) implementation of the [`VectorStore.Store`](../vector-store/README.md) abstract. Cosine / dot / euclidean similarity via pgvector distance operators over a dedicated table inside an existing [`Sql.Connection`](../sql/README.md), so vectors live in the same database as your relational data.

## Why use this

- **One database** — the store references an `Sql.Connection` you already run; its table sits beside your other tables. No separate vector service.
- **Owns its table** — on init the backend provisions the `vector` extension, the vectors table, and an HNSW ANN index. The table name is configurable (`table`), so multiple stores can share one database.
- **Three metrics** — `cosine` (default), `dot`, or `euclidean`, mapped to the pgvector `<=>` / `<#>` / `<->` operators and their matching index opclass. Higher `score` is always better.
- **Authoritative dimensions** — the column is `vector(dimensions)`; inserts / queries of any other length are rejected, catching mismatched embeddings early.

## Requirements

The referenced connection must point at a PostgreSQL server with the [pgvector](https://github.com/pgvector/pgvector) extension available (e.g. the `pgvector/pgvector` images). The backend runs `CREATE EXTENSION IF NOT EXISTS vector` on init, which needs a role permitted to create the extension.

## Kinds

| Kind | Capability | Purpose |
| --- | --- | --- |
| `VectorStorePgvector.Store` | Provider | Postgres/pgvector vector index; satisfies `VectorStore.Store`. |

## Config

| Field | Default | Purpose |
| --- | --- | --- |
| `connection` | — (required) | `!ref` to the Postgres `Sql.Connection` the table lives in. |
| `dimensions` | — (required) | Vector length; fixes the `vector(N)` column. Changing it is a re-embed. |
| `metric` | `cosine` | Similarity metric (`cosine` / `dot` / `euclidean`). |
| `table` | `vectors` | Table name the backend owns; created if absent. |

## Metadata filter mapping

`VectorStorePgvector.Store` translates the shared [`metadataFilter`](../vector-store/README.md#metadata-filter) grammar into a parameterized JSONB predicate over the `metadata` column (never string-spliced):

| Operator | Translation |
| --- | --- |
| `$eq` / `$ne` | `metadata->'f' = / IS DISTINCT FROM $n::jsonb` |
| `$gt` / `$gte` / `$lt` / `$lte` | `(metadata->>'f')::numeric` compared, guarded on `jsonb_typeof = 'number'` |
| `$in` / `$nin` | `= ANY(ARRAY[…])` / negated |
| `$and` / `$or` / `$not` | recursive compose |

An unsupported operator throws rather than silently matching, preserving parity with the other backends.

## Example

```yaml
imports:
  Sql: std/sql@latest
  Postgres: std/sql-postgres@latest
  VectorStore: std/vector-store@latest
  VectorStorePgvector: std/vector-store-pgvector@latest
---
kind: Postgres.Connection
metadata: { name: Db }
connectionString: !cel "secrets.dbConnection"
---
kind: VectorStorePgvector.Store
metadata: { name: Index }
connection: !ref Db
metric: cosine
dimensions: 768
table: resource_vectors
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
