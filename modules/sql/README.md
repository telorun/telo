# SQL

SQL database access for PostgreSQL and SQLite — connections, raw queries, a declarative SELECT builder, transactions, and migrations.

## Why use this

- **Two backends, one shape** — `postgres` (pg + Kysely) and `sqlite` (Node SQLite) share the same resource kinds.
- **Raw and structured** — `Sql.Query` / `Sql.Exec` for hand-written SQL; `Sql.Select` for declarative SELECTs as data.
- **Implicit transactions** — `Sql.Transaction` propagates the active transaction through `AsyncLocalStorage`; nested invocations pick it up automatically.
- **Idempotent migrations** — `Sql.Migrations` applies its keyed migration entries in lexicographic key order and tracks applied versions in a metadata table.
- **Tunable pooling** — Postgres pool `min`, `max`, and timeout knobs exposed on `Sql.Connection`.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Sql.Connection` | Long-lived database connection (pool for Postgres, single handle for SQLite). |
| `Sql.Query` | Raw SQL with positional bindings; returns rows plus row count. |
| `Sql.Exec` | Same shape as `Sql.Query` for statements that do not return rows. |
| `Sql.Select` | Declarative SELECT builder — columns, filters, ordering, pagination, grouping. |
| `Sql.Transaction` | Wraps an invocable in a database transaction; nested transactions are flattened. |
| `Sql.Migrations` | Boot-time runner holding a keyed `migrations` map; applies pending entries in key order. |
| `Sql.Migration` | **Deprecated** — standalone migration entry, discovered and merged by `Sql.Migrations`. Prefer the inline map. |

## Example

```yaml
kind: Telo.Application
metadata: { name: users-api, version: 1.0.0 }
imports:
  Sql: std/sql@0.5.1
targets: [ Migrate ]
secrets:
  DATABASE_URL: { type: string }
---
kind: Sql.Connection
metadata: { name: Db }
connectionString: "${{ secrets.DATABASE_URL }}"
pool: { min: 2, max: 20, idleTimeoutMs: 10000 }
---
kind: Sql.Migrations
metadata: { name: Migrate }
connection: { kind: Sql.Connection, name: Db }
migrations:
  20260401120000_CreateUsers:
    statement: |
      CREATE TABLE users (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email      TEXT UNIQUE NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
  20260402090000_IndexEmail:
    statements:
      - CREATE INDEX users_email ON users(email)
      - CREATE INDEX users_created_at ON users(created_at)
---
kind: Sql.Select
metadata: { name: ActiveUsers }
connection: { kind: Sql.Connection, name: Db }
from: users
columns: [ id, email ]
where:
  - { column: deleted_at, op: is_null }
orderBy:
  - { column: created_at, direction: desc }
limit: 50
```

## Connection strings

The `connectionString` scheme selects the driver — there is no separate `driver` field, and the scheme is mandatory.

| Scheme | Backend | Examples |
| --- | --- | --- |
| `postgres://` / `postgresql://` | `pg` + Kysely | `postgres://user:pass@host:5432/db` |
| `sqlite:` | Node SQLite (better-sqlite3) | `sqlite::memory:`, `sqlite:./data.db`, `sqlite:///abs/path.db` |

PostgreSQL TLS is configured with the standard libpq `sslmode` query parameter: `?sslmode=require` encrypts without verifying the server certificate (suitable for managed Postgres that self-signs), while `?sslmode=verify-ca` / `?sslmode=verify-full` verify it. Omitting it (or `?sslmode=disable`) connects without TLS. The `pool` knobs (`min`, `max`, `idleTimeoutMs`, `connectionTimeoutMs`) apply to PostgreSQL only.

SQLite file paths auto-create their parent directory on connect; use `sqlite::memory:` for an ephemeral database.

## Migrations

`Sql.Migrations` owns its migrations as a keyed `migrations` map. Each **key** is the durable ledger id: it is written to the migrations tracking table, decides run order (lexicographic over keys), and identifies the migration forever after — renaming a key makes the migrator think it's a new migration and try to re-run it. Conventionally a timestamp-prefixed slug (e.g. `20260419100200_CreateTokens`). The key is both order and identity, so there is no separate `version` field.

Each value is **either** a single `statement` **or** an ordered list of `statements` (exactly one). Use `statements` when a logical migration needs several SQL statements. Values may contain `${{ }}` CEL expressions, evaluated at compile time.

**All pending migrations run in a single transaction** — every statement of every entry commits together, or the whole batch rolls back on the first failure (PostgreSQL natively; SQLite via a transactional-DDL adapter). Note: statements that cannot run inside a transaction block (e.g. PostgreSQL `CREATE INDEX CONCURRENTLY`) are therefore not supported here.

Make the Application `targets` list include the `Sql.Migrations` resource so schema evolution happens before services start serving traffic.

The standalone `Sql.Migration` kind is **deprecated** but still supported: any `Sql.Migration` resource in the same module scope is discovered and merged into the runner's migration set, keyed by its `version` (falling back to `metadata.name`). Entries in the inline `migrations` map take precedence on a key collision. New manifests should use the inline map.
