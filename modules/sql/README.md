# SQL

Driver-agnostic SQL database access — the `Sql.Connection` abstract plus raw queries, a declarative SELECT builder, transactions, and the `Sql.Table` / `Sql.Schema` contracts behind declarative schema. Concrete drivers ship as their own modules — [`postgres`](../postgres/README.md) (`Postgres.Connection`) and [`sqlite`](../sqlite/README.md) (`SQLite.Connection`) — and `extend` `Sql.Connection`, mirroring the `cache` / `cache-*` family. The `sql` core depends on no database driver.

## Why use this

- **Two backends, one shape** — `Postgres.Connection` (pg + Kysely) and `SQLite.Connection` (Node SQLite) implement the same `Sql.Connection` abstract, so every other kind references a connection driver-agnostically.
- **Safe inline values** — write bound parameters directly in SQL with the `!sql` tag (`WHERE id = ${{ x }}`); each interpolation is bound, never spliced — dialect-neutral and injection-safe.
- **Raw and structured** — `Sql.Query` / `Sql.Command` for hand-written SQL; `Sql.Selection` for declarative SELECTs as data.
- **Implicit transactions, checked statically** — `Sql.Transaction` opens an execution zone around its body; every statement reached through it joins automatically, per connection. A statement that names a `transaction:` declares a *requirement*, and `telo check` reports a path that reaches it outside one — see [Transactions](docs/transactions.md).
- **Declarative schema with deferred reclamation** — declare the table, not the DDL. A removal is recorded rather than executed, and reclaimed only once a stated number of released versions and a stated time have passed — see [Declarative schema](docs/declarative-schema.md).
- **Tunable pooling** — each backend exposes its own connection and pool settings; see [`postgres`](../postgres/README.md).

## Docs

- [Declarative schema](docs/declarative-schema.md) — declaring tables instead of migrating to them, and how tombstoning and reclamation work.
- [Transactions](docs/transactions.md) — how membership works (ambient, per connection), what `transaction:` actually declares, and what `telo check` reports.
- [Writing a SQL backend](docs/writing-a-backend.md) — what a backend owes in any language: the kind, the connection behaviours, the dialect, the lifecycle.
- [Node backends](docs/nodejs-backend.md) — the `@telorun/sql` helper library (`SqlConnection` / `SqlDialect` / `SqlConnectionBase`) for backends written in TypeScript.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Sql.Connection` | **Abstract** database-connection contract; reference it from any consumer (`x-telo-ref: Sql.Connection`). |
| `Postgres.Connection` | PostgreSQL connection (pool + `sslmode`); implements `Sql.Connection`. |
| `SQLite.Connection` | SQLite connection (`file` or in-memory); implements `Sql.Connection`. |
| `Sql.Query` | SQL returning rows plus row count; inline `!sql` binding or `bindings` escape hatch. |
| `Sql.Command` | Same shape as `Sql.Query` for statements that do not return rows. |
| `Sql.Selection` | Declarative SELECT builder — columns, filters, ordering, pagination, grouping. |
| `Sql.Transaction` | Wraps an executable in a database transaction; a nested transaction on the same connection joins the enclosing one. |
| `Sql.Table` | **Abstract** declared table; each backend supplies its own (`Postgres.Table`, `SQLite.Table`) in its own type vocabulary. |
| `Sql.Schema` | **Abstract** schema-change contract — the clock (`version:`), the reclamation policy and the observed state it reports. Backends supply `Postgres.Schema` / `SQLite.Schema`. |

## Example

```yaml
kind: Telo.Application
metadata: { name: users-api, version: 1.0.0 }
imports:
  Sql: oci://ghcr.io/telorun/sql@0.13.0
  Postgres: oci://ghcr.io/telorun/postgres@0.1.0
targets: [ !ref appSchema ]
secrets:
  DATABASE_URL: { env: DATABASE_URL, type: string }
---
kind: Postgres.Connection
metadata: { name: Db }
connectionString: !cel "secrets.DATABASE_URL"
pool: { min: 2, max: 20, idleTimeoutMs: 10000 }
---
kind: Postgres.Table
metadata: { name: users }
table: users
columns:
  id:    { type: uuid, primaryKey: true, defaultExpression: "gen_random_uuid()" }
  email: { type: text, nullable: false, unique: true }
---
kind: Postgres.Schema
metadata: { name: appSchema }
connection: !ref Db
version: !cel "module.version"
tables: [ !ref users ]
reclaim: { afterVersions: 3, afterDuration: 30d }
```

## Connections

`Sql.Connection` is an abstract contract; pick the concrete kind for your driver. Every other kind references the connection by name (`connection: !ref Db`) and stays driver-agnostic.

**`Postgres.Connection`** — `connectionString` is a `postgres://` / `postgresql://` URL (e.g. `postgres://user:pass@host:5432/db`). TLS uses the standard libpq `sslmode` query parameter: `?sslmode=require` encrypts without verifying the server certificate (suitable for managed Postgres that self-signs), while `?sslmode=verify-ca` / `?sslmode=verify-full` verify it; omitting it (or `?sslmode=disable`) connects without TLS. The `pool` knobs (`min`, `max`, `idleTimeoutMs`, `connectionTimeoutMs`) tune the connection pool.

**`SQLite.Connection`** — `file` is the database path (e.g. `./data.db`); its parent directory is auto-created on connect. Omit `file`, or set `:memory:`, for an ephemeral in-memory database.

The engine family is fixed by the kind, not sniffed from a string at runtime. Keep the connection *target* in the environment as usual — e.g. `Postgres.Connection` with `connectionString: !cel "secrets.DATABASE_URL"`.

`Sql.Connection` itself is abstract and has no controller — declaring `kind: Sql.Connection` fails with **"No controller registered"**. Always instantiate a concrete kind (`Postgres.Connection` / `SQLite.Connection`); reference the abstract only in `x-telo-ref` slots (which you don't write — they're in the kind schemas).

## What is logged

Each statement logs at `debug` with `db.query.text`, the row count and the elapsed time, as do transaction start, commit and rollback. **Parameters are never logged** — the bound values *are* the row data. The statement text is safe for a parameterized query, since it is the template with placeholders; it is `debug`-only regardless, because `Sql.Command` can carry inline literals.

A schema resource logs **each applied migration, each reconciled object and each reclamation at `info`**. A schema change is the least reversible thing an app does at boot, and which migrations a given deployment applied is what you go looking for when a schema is not what you expected.

## Reusing handlers

`Sql.Query`, `Sql.Command`, and `Sql.Selection` are Invocables: declare one as a **top-level named resource** and reference it by `{ kind, name }` from any number of routes or `Run.Sequence` steps — define a query once, reuse it everywhere. (Inlining a handler on a single route also works for one-offs.)

```yaml
kind: Sql.Selection
metadata: { name: ActiveUsers }      # declared once
connection: !ref Db
from: users
columns: [ id, email ]
---
kind: Http.Api
metadata: { name: Api }
routes:
  - request: { path: /users, method: GET }
    handler: !ref ActiveUsers   # referenced by name
```

## Binding values

Never concatenate values into SQL. Two ways to bind, both injection-safe:

**Inline (`!sql`)** — write the value where it belongs; each `${{ }}` is bound as a parameter with the driver's native placeholder, never spliced into the text. Dialect-neutral — the same query runs on Postgres or SQLite.

```yaml
- name: GetUser
  invoke: { kind: Sql.Query, connection: !ref Db }
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

## Schema

Declare the table, not the DDL. A backend's `Table` kind states columns, indexes
and foreign keys in that engine's own vocabulary, and its `Schema` kind brings
the database to what is declared at start-up: creating what is absent, applying
imperative migrations before and after the pass, and **recording** a removal
rather than executing it.

A removed object is tombstoned and dropped only once the declared policy has been
met — N released versions observed and T elapsed — so the version still running
keeps reading it. The clock is the `version:` you write, conventionally
`!cel "module.version"`.

Imperative migrations still live here, on the same resource, so their order
relative to the reconciliation pass is defined: `prepare:` runs before
it, `migrations:` after. Keys are unique across both and identify a migration
forever after; renaming one makes it a new migration.

Make the Application `targets` list include the schema resource so schema
evolution happens before services start serving traffic.

See [Declarative schema](docs/declarative-schema.md) for tombstoning, reclamation,
renames, ownership of an adopted database, and why there is no neutral type
vocabulary.

