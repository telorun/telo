# SQL

SQL database access for PostgreSQL and SQLite. The module provides a single connection resource, two raw-SQL invocables (`Sql.Query` / `Sql.Exec`), a declarative SELECT builder (`Sql.Select`), transaction scoping, and a migration runner.

Drivers:

| Driver     | Backend       | Notes                                            |
| ---------- | ------------- | ------------------------------------------------ |
| `postgres` | `pg` + Kysely | Production default. Pool settings are tunable.   |
| `sqlite`   | Node SQLite   | Use `:memory:` for tests, a file path otherwise. |

---

## Sql.Connection

A long-lived connection (pool for Postgres, a single handle for SQLite). Everything else in the module takes an `x-telo-ref` back to an `Sql.Connection`.

```yaml
kind: Sql.Connection
metadata:
  name: Db
driver: postgres
connectionString: "${{ resources.AppConfig.dbUrl }}"
pool:
  min: 2
  max: 20
  idleTimeoutMs: 10000
```

Provide `connectionString` or the structured fields (`host`, `port`, `database`, `user`, `password`). `ssl: true` opts into TLS with relaxed CA verification — suitable for managed Postgres services that self-sign.

For SQLite use `driver: sqlite` and `file:` (path or `:memory:`).

---

## Sql.Query

Raw SQL with positional bindings. Returns rows plus a row count.

```yaml
kind: Sql.Query
metadata:
  name: GetUser
connection:
  kind: Sql.Connection
  name: Db
inputs:
  sql: "SELECT id, email FROM users WHERE id = $1"
  bindings:
    - "${{ inputs.id }}"
```

Result shape:

```ts
{ rows: Array<Record<string, unknown>>; rowCount: number }
```

`inputs.sql` and `inputs.bindings` are evaluated per invocation, so CEL templates in the SQL string are fine — the controller still parameterizes `bindings` to prevent injection.

Use `Sql.Query` for JOINs, CTEs, window functions, or anything else that does not fit `Sql.Select`.

---

## Sql.Exec

Same shape as `Sql.Query`, but intended for statements that do not return rows — `INSERT`, `UPDATE`, `DELETE`, DDL. Result exposes `rowCount`.

```yaml
kind: Sql.Exec
metadata:
  name: DeleteModule
connection:
  kind: Sql.Connection
  name: Db
inputs:
  sql: "DELETE FROM modules WHERE namespace = $1 AND name = $2"
  bindings:
    - "${{ inputs.namespace }}"
    - "${{ inputs.name }}"
```

---

## Sql.Select

Declarative `SELECT` builder. Expresses query structure as data — columns, filters, ordering, pagination, grouping — without writing raw SQL.

```yaml
kind: Sql.Select
metadata:
  name: ActiveUsers
connection:
  kind: Sql.Connection
  name: Db
from: users
columns: [id, name, email]
where:
  - { column: deleted_at, op: is_null }
  - { column: status, op: eq, value: active }
orderBy:
  - { column: created_at, direction: desc }
limit: 50
```

Full reference: [Sql.Select](./select.md).

---

## Sql.Transaction

Wraps another invocable in a database transaction. Anything that resolves its `Sql.Connection` during the nested invocation picks up the active transaction automatically (via `AsyncLocalStorage`) — no need to thread a transaction reference through every step.

```yaml
kind: Sql.Transaction
metadata:
  name: TransferFunds
connection:
  kind: Sql.Connection
  name: Db
steps:
  kind: Run.Sequence
  name: Transfer
```

Nested transactions are flattened — if `TransferFunds` is invoked inside another `Sql.Transaction`, the inner one reuses the outer transaction rather than opening a new one.

---

## Sql.Migrations and Sql.Migration

Boot-time schema evolution. `Sql.Migration` declares a single migration; `Sql.Migrations` runs all migrations in definition order against a connection.

```yaml
kind: Sql.Migrations
metadata:
  name: Migrate
connection:
  kind: Sql.Connection
  name: Db
---
kind: Sql.Migration
metadata:
  name: 20260401120000_CreateUsers
sql: |
  CREATE TABLE users (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email      TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
```

The runner tracks applied migrations in a metadata table and is idempotent — already-applied migrations are skipped. Use timestamp-prefixed names so the order is stable.

Make the Application `targets` list include `Migrate` so schema evolution happens before services start serving traffic.
