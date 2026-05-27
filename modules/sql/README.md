# SQL

SQL database access for PostgreSQL and SQLite — connections, raw queries, a declarative SELECT builder, transactions, and migrations.

## Why use this

- **Two backends, one shape** — `postgres` (pg + Kysely) and `sqlite` (Node SQLite) share the same resource kinds.
- **Raw and structured** — `Sql.Query` / `Sql.Exec` for hand-written SQL; `Sql.Select` for declarative SELECTs as data.
- **Implicit transactions** — `Sql.Transaction` propagates the active transaction through `AsyncLocalStorage`; nested invocations pick it up automatically.
- **Idempotent migrations** — `Sql.Migrations` applies `Sql.Migration` entries in lexicographic order and tracks applied versions in a metadata table.
- **Tunable pooling** — Postgres pool `min`, `max`, and timeout knobs exposed on `Sql.Connection`.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Sql.Connection` | Long-lived database connection (pool for Postgres, single handle for SQLite). |
| `Sql.Query` | Raw SQL with positional bindings; returns rows plus row count. |
| `Sql.Exec` | Same shape as `Sql.Query` for statements that do not return rows. |
| `Sql.Select` | Declarative SELECT builder — columns, filters, ordering, pagination, grouping. |
| `Sql.Transaction` | Wraps an invocable in a database transaction; nested transactions are flattened. |
| `Sql.Migration` | Single migration entry with a durable `version` and `sql:` body. |
| `Sql.Migrations` | Boot-time runner that applies pending migrations in version order. |

## Example

```yaml
kind: Telo.Application
metadata: { name: users-api, version: 1.0.0 }
targets: [Migrate]
secrets:
  DATABASE_URL: { type: string }
---
kind: Telo.Import
metadata: { name: Sql }
source: std/sql@0.3.0
---
kind: Sql.Connection
metadata: { name: Db }
driver: postgres
connectionString: "${{ secrets.DATABASE_URL }}"
pool: { min: 2, max: 20, idleTimeoutMs: 10000 }
---
kind: Sql.Migrations
metadata: { name: Migrate }
connection: { kind: Sql.Connection, name: Db }
---
kind: Sql.Migration
metadata: { name: Migration_20260401120000_CreateUsers }
version: 20260401120000_CreateUsers
sql: |
  CREATE TABLE users (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email      TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
---
kind: Sql.Select
metadata: { name: ActiveUsers }
connection: { kind: Sql.Connection, name: Db }
from: users
columns: [id, email]
where:
  - { column: deleted_at, op: is_null }
orderBy:
  - { column: created_at, direction: desc }
limit: 50
```

## Driver Notes

| Driver | Backend | Notes |
| --- | --- | --- |
| `postgres` | `pg` + Kysely | Production default. Pool settings are tunable. |
| `sqlite` | Node SQLite | Use `:memory:` for tests, a file path otherwise. |

For Postgres provide `connectionString` or the structured fields (`host`, `port`, `database`, `user`, `password`). `ssl: true` opts into TLS with relaxed CA verification — suitable for managed Postgres services that self-sign. For SQLite use `driver: sqlite` and `file:` (path or `:memory:`).

## Migrations

`version` is the durable key written to the migrations tracking table. It decides run order (lexicographic) and identifies the migration forever after — renaming a `version` makes the migrator think it's a new migration and try to re-run it. Conventionally a timestamp-prefixed slug. If omitted, the controller falls back to `metadata.name`, but `metadata.name` must satisfy Telo's resource-name rules (`^[a-zA-Z_][a-zA-Z0-9_]*$`, no leading digit), which is why new migrations should set `version` explicitly and give `metadata.name` a `Migration_`-prefixed handle.

Make the Application `targets` list include the `Sql.Migrations` resource so schema evolution happens before services start serving traffic.
