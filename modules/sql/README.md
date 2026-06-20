# SQL

Driver-agnostic SQL database access — the `Sql.Connection` abstract plus raw queries, a declarative SELECT builder, transactions, and migrations. Concrete drivers ship as their own modules — [`sql-postgres`](../sql-postgres/README.md) (`SqlPostgres.Connection`) and [`sql-sqlite`](../sql-sqlite/README.md) (`SqlSqlite.Connection`) — and `extend` `Sql.Connection`, mirroring the `cache` / `cache-*` family. The `sql` core depends on no database driver.

## Why use this

- **Two backends, one shape** — `SqlPostgres.Connection` (pg + Kysely) and `SqlSqlite.Connection` (Node SQLite) implement the same `Sql.Connection` abstract, so every other kind references a connection driver-agnostically.
- **Safe inline values** — write bound parameters directly in SQL with the `!sql` tag (`WHERE id = ${{ x }}`); each interpolation is bound, never spliced — dialect-neutral and injection-safe.
- **Raw and structured** — `Sql.Query` / `Sql.Command` for hand-written SQL; `Sql.Selection` for declarative SELECTs as data.
- **Implicit transactions** — `Sql.Transaction` propagates the active transaction through `AsyncLocalStorage`; nested invocations pick it up automatically.
- **Idempotent migrations** — `Sql.Migrations` applies its keyed migration entries in lexicographic key order and tracks applied versions in a metadata table.
- **Tunable pooling** — Postgres pool `min`, `max`, and timeout knobs exposed on `SqlPostgres.Connection`.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Sql.Connection` | **Abstract** database-connection contract; reference it from any consumer (`x-telo-ref: std/sql#Connection`). |
| `SqlPostgres.Connection` | PostgreSQL connection (pool + `sslmode`); implements `Sql.Connection`. |
| `SqlSqlite.Connection` | SQLite connection (`file` or in-memory); implements `Sql.Connection`. |
| `Sql.Query` | SQL returning rows plus row count; inline `!sql` binding or `bindings` escape hatch. |
| `Sql.Command` | Same shape as `Sql.Query` for statements that do not return rows. |
| `Sql.Selection` | Declarative SELECT builder — columns, filters, ordering, pagination, grouping. |
| `Sql.Transaction` | Wraps an invocable in a database transaction; nested transactions are flattened. |
| `Sql.Migrations` | Boot-time runner holding a keyed `migrations` map; applies pending entries in key order. |
| `Sql.Migration` | **Deprecated** — standalone migration entry, discovered and merged by `Sql.Migrations`. Prefer the inline map. |

## Example

```yaml
kind: Telo.Application
metadata: { name: users-api, version: 1.0.0 }
imports:
  Sql: std/sql@<version>
  SqlPostgres: std/sql-postgres@<version>
targets: [ !ref Migrate ]
secrets:
  DATABASE_URL: { type: string }
---
kind: SqlPostgres.Connection
metadata: { name: Db }
connectionString: "${{ secrets.DATABASE_URL }}"
pool: { min: 2, max: 20, idleTimeoutMs: 10000 }
---
kind: Sql.Migrations
metadata: { name: Migrate }
connection: { kind: SqlPostgres.Connection, name: Db }
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
kind: Sql.Selection
metadata: { name: ActiveUsers }
connection: { kind: SqlPostgres.Connection, name: Db }
from: users
columns: [ id, email ]
where:
  - { column: deleted_at, op: is_null }
orderBy:
  - { column: created_at, direction: desc }
limit: 50
```

## Connections

`Sql.Connection` is an abstract contract; pick the concrete kind for your driver. Every other kind references the connection by name (`connection: { kind: SqlPostgres.Connection, name: Db }`) and stays driver-agnostic.

**`SqlPostgres.Connection`** — `connectionString` is a `postgres://` / `postgresql://` URL (e.g. `postgres://user:pass@host:5432/db`). TLS uses the standard libpq `sslmode` query parameter: `?sslmode=require` encrypts without verifying the server certificate (suitable for managed Postgres that self-signs), while `?sslmode=verify-ca` / `?sslmode=verify-full` verify it; omitting it (or `?sslmode=disable`) connects without TLS. The `pool` knobs (`min`, `max`, `idleTimeoutMs`, `connectionTimeoutMs`) tune the connection pool.

**`SqlSqlite.Connection`** — `file` is the database path (e.g. `./data.db`); its parent directory is auto-created on connect. Omit `file`, or set `:memory:`, for an ephemeral in-memory database.

The engine family is fixed by the kind, not sniffed from a string at runtime. Keep the connection *target* in the environment as usual — e.g. `SqlPostgres.Connection` with `connectionString: "${{ secrets.DATABASE_URL }}"`.

`Sql.Connection` itself is abstract and has no controller — declaring `kind: Sql.Connection` fails with **"No controller registered"**. Always instantiate a concrete kind (`SqlPostgres.Connection` / `SqlSqlite.Connection`); reference the abstract only in `x-telo-ref` slots (which you don't write — they're in the kind schemas).

## Reusing handlers

`Sql.Query`, `Sql.Command`, and `Sql.Selection` are Invocables: declare one as a **top-level named resource** and reference it by `{ kind, name }` from any number of routes or `Run.Sequence` steps — define a query once, reuse it everywhere. (Inlining a handler on a single route also works for one-offs.)

```yaml
kind: Sql.Selection
metadata: { name: ActiveUsers }      # declared once
connection: { kind: SqlPostgres.Connection, name: Db }
from: users
columns: [ id, email ]
---
kind: Http.Api
metadata: { name: Api }
routes:
  - request: { path: /users, method: GET }
    handler: { kind: Sql.Selection, name: ActiveUsers }   # referenced by name
```

## Binding values

Never concatenate values into SQL. Two ways to bind, both injection-safe:

**Inline (`!sql`)** — write the value where it belongs; each `${{ }}` is bound as a parameter with the driver's native placeholder, never spliced into the text. Dialect-neutral — the same query runs on Postgres or SQLite.

```yaml
- name: GetUser
  invoke: { kind: Sql.Query, connection: { kind: SqlPostgres.Connection, name: Db } }
  inputs:
    sql: !sql "SELECT * FROM users WHERE id = ${{ request.params.id }}"
```

`!sql` embeds *values* into a statement — it can't parameterize a whole statement. A `!sql` whose entire body is a single interpolation (`!sql "${{ wholeQuery }}"`) binds that value as one parameter rather than running it as SQL, which a database will reject. Build dynamic statements from a fixed SQL skeleton with interpolated values, not by interpolating the statement itself.

**Escape hatch (`bindings`)** — hand-write placeholders and pass a positional array. Use this for value reuse or generated SQL. Placeholders are driver-specific (SQLite `?`, PostgreSQL `$1`, `$2`). Tag each dynamic element with its own `!cel` leaf rather than building one inline list literal (CEL list literals must be homogeneously typed):

```yaml
inputs:
  sql: "INSERT INTO users (email, age) VALUES (?, ?)"
  bindings:
    - !cel "request.body.email"
    - !cel "request.body.age"
```

Drivers accept only primitives (string, number, bigint, null, bytes) — serialize an object/array first, e.g. `!cel "json(request.body)"`, to store it in a TEXT/JSON column. A `!sql` template and `bindings` cannot be combined.

## Migrations

`Sql.Migrations` owns its migrations as a keyed `migrations` map. Each **key** is the durable ledger id: it is written to the migrations tracking table, decides run order (lexicographic over keys), and identifies the migration forever after — renaming a key makes the migrator think it's a new migration and try to re-run it. Conventionally a timestamp-prefixed slug (e.g. `20260419100200_CreateTokens`). The key is both order and identity, so there is no separate `version` field.

Each value is **either** a single `statement` **or** an ordered list of `statements` (exactly one). Use `statements` when a logical migration needs several SQL statements. Values may contain `${{ }}` CEL expressions, evaluated at compile time.

**All pending migrations run in a single transaction** — every statement of every entry commits together, or the whole batch rolls back on the first failure (PostgreSQL natively; SQLite via a transactional-DDL adapter). Note: statements that cannot run inside a transaction block (e.g. PostgreSQL `CREATE INDEX CONCURRENTLY`) are therefore not supported here.

Make the Application `targets` list include the `Sql.Migrations` resource so schema evolution happens before services start serving traffic.

The standalone `Sql.Migration` kind is **deprecated** but still supported: any `Sql.Migration` resource in the same module scope is discovered and merged into the runner's migration set, keyed by its `version` (falling back to `metadata.name`). Entries in the inline `migrations` map take precedence on a key collision. New manifests should use the inline map.
