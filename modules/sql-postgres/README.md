# SQL Postgres

`SqlPostgres.Connection` — a PostgreSQL backend for the [`sql`](../sql/README.md) module's `Sql.Connection` abstract. Backed by a `pg` connection pool and Kysely; the `sql` core itself depends on no driver.

Every `sql` operation (`Sql.Query`, `Sql.Command`, `Sql.Selection`, `Sql.Transaction`, `Sql.Migrations`) references the connection driver-agnostically via `x-telo-ref: "std/sql#Connection"`; this module satisfies that ref.

## Usage

```yaml
imports:
  Sql: std/sql@<version>
  SqlPostgres: std/sql-postgres@0.1.0
---
kind: SqlPostgres.Connection
metadata: { name: Db }
connectionString: "${{ secrets.DATABASE_URL }}"
pool: { min: 2, max: 20, idleTimeoutMs: 10000 }
---
kind: Sql.Query
metadata: { name: GetUser }
connection: !ref Db
inputs:
  sql: !sql "SELECT id, email FROM users WHERE id = ${{ request.params.id }}"
```

## Schema

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `connectionString` | string | yes | `postgres://` / `postgresql://` URL. TLS via the libpq `?sslmode=` parameter (`disable`, `require`, `verify-ca`, `verify-full`). |
| `pool.min` | integer | no | Minimum pooled connections (default 1). |
| `pool.max` | integer | no | Maximum pooled connections (default 10). |
| `pool.idleTimeoutMs` | integer | no | Milliseconds before idle connections close. |
| `pool.connectionTimeoutMs` | integer | no | Milliseconds to wait for a new connection. |

The connection's bind-placeholder style is fixed to PostgreSQL numbered (`$1`, `$2`, …), so inline `${{ }}` parameters stay dialect-neutral.
