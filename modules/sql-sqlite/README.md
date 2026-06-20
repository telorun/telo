# SQL SQLite

`SqlSqlite.Connection` — a SQLite backend for the [`sql`](../sql/README.md) module's `Sql.Connection` abstract. Opens a file-backed or in-memory database (`better-sqlite3` on Node, `bun:sqlite` on Bun) with transactional DDL; the `sql` core itself depends on no driver.

Every `sql` operation (`Sql.Query`, `Sql.Command`, `Sql.Selection`, `Sql.Transaction`, `Sql.Migrations`) references the connection driver-agnostically via `x-telo-ref: "std/sql#Connection"`; this module satisfies that ref.

## Usage

```yaml
imports:
  Sql: std/sql@<version>
  SqlSqlite: std/sql-sqlite@0.1.0
---
kind: SqlSqlite.Connection
metadata: { name: Db }
file: ./data.db
---
kind: Sql.Command
metadata: { name: AddUser }
connection: !ref Db
inputs:
  sql: !sql "INSERT INTO users (name) VALUES (${{ request.body.name }})"
```

## Schema

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `file` | string | no | Database file path (e.g. `./data.db`); the parent directory is auto-created. Omit, or use `:memory:`, for an in-memory database. |

The connection's bind-placeholder style is fixed to SQLite anonymous `?`, so inline `${{ }}` parameters stay dialect-neutral. Migrations run with transactional DDL (a transactional-SQLite adapter wraps the batch), matching PostgreSQL.
