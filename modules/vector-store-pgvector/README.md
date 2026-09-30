# Vector Store pgvector

`VectorStorePgvector.Store` — a Postgres/[pgvector](https://github.com/pgvector/pgvector) implementation of the [`VectorStore.Store`](../vector-store/README.md) abstract. Cosine / dot / euclidean similarity via pgvector distance operators over a dedicated table inside an existing [`Sql.Connection`](../sql/README.md), so vectors live in the same database as your relational data.

## Why use this

- **One database** — the store references an `Sql.Connection` you already run; its table sits beside your other tables. No separate vector service.
- **Owns its table** — on init the backend provisions the `vector` extension, the vectors table, and an HNSW ANN index. The table name is configurable (`table`), so multiple stores can share one database.
- **Three metrics** — `cosine` (default), `dot`, or `euclidean`, mapped to the pgvector `<=>` / `<#>` / `<->` operators and their matching index opclass. Higher `score` is always better.
- **Authoritative dimensions** — the column is `vector(dimensions)`; inserts / queries of any other length are rejected, catching mismatched embeddings early.

## Requirements

The referenced connection must point at a PostgreSQL server with **pgvector ≥ 0.8.0** available (e.g. the `pgvector/pgvector` images). The backend runs `CREATE EXTENSION IF NOT EXISTS vector` on init, which needs a role permitted to create the extension, and then refuses to start on an older extension, naming the installed version: install pgvector 0.8.0 or later on the server and run `ALTER EXTENSION vector UPDATE` in the database. The connection must be a `Postgres.Connection` (a match opens its own transaction through it).

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

## Filtered matches

Every match runs as an iterative HNSW index scan in strict distance order (`hnsw.iterative_scan = strict_order`), so the filter is applied as the index is walked and the walk continues until `topK` rows have matched. An entry the filter excludes never takes a match's place, and a `topK` above `hnsw.ef_search` (40 by default) is met — a plain HNSW scan would stop at its `ef_search` candidates and filter those, returning fewer rows or none. The setting is `SET LOCAL` in a transaction around the match statement, so it never outlives the statement; inside a caller's `Sql.Transaction` the match joins that transaction and restores the caller's value afterwards.

The walk is bounded by `hnsw.max_scan_tuples` (20,000 by default): a filter so selective that fewer than `topK` of the first 20,000 entries visited match returns fewer than `topK` rows. Raise the bound on the server (`ALTER DATABASE … SET hnsw.max_scan_tuples = …`) if a filter needs it. When the planner estimates a sequential scan cheaper — usually on a small table — the match is exact.

## Example

```yaml
imports:
  Sql: oci://ghcr.io/telorun/sql@0.13.0
  Postgres: oci://ghcr.io/telorun/postgres@0.2.1
  VectorStore: oci://ghcr.io/telorun/vector-store@0.4.0
  VectorStorePgvector: oci://ghcr.io/telorun/vector-store-pgvector@0.3.0
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
