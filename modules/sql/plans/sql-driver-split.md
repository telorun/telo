# SQL driver split

Split the monolithic `sql` module into a driver-agnostic **core** plus per-driver
**backend** modules, mirroring `cache` / `cache-memory` / `cache-redis` and
`codec` / `*-codec`. The core keeps the `Sql.Connection` abstract and every
operation (`Query` / `Command` / `Selection` / `Transaction` / `Migrations`);
each concrete connection moves to its own module and `extends` the abstract.

The split also folds in **declarative-name renames** for the two operations
whose names were verbs/abbreviations (see "Resource renames").

## Why

- **Isolate driver deps.** Core today pulls in both `pg` and `better-sqlite3`
  (the `SqlConnectionResource` constructor hard-codes both kysely dialects). A
  SQLite-only app installs `pg`, and vice versa. After the split each backend
  module owns exactly its driver.
- **Open the backend set.** New drivers (MySQL, libSQL, D1, …) land as their own
  modules without touching core — the codebase's stated "backends in their own
  modules" direction.
- **Give connections a stable concrete identity.** Downstream modules
  (`vector-store-pgvector`) need to reference *a Postgres connection
  specifically*, not the abstract. The split makes `SqlPostgres.Connection` a
  first-class kind a concrete `x-telo-ref` pins to — a wrong-driver wiring then
  fails `telo check` statically (see "Strict connection ref").

## Resource renames (declarative names)

The two operations named for verbs/abbreviations get declarative nouns. Schemas,
inputs, outputs, and behaviour are **unchanged** — name-only.

| Old kind | New kind | Why |
| --- | --- | --- |
| `Sql.Exec` | **`Sql.Command`** | `Exec` is a verb-abbreviation. `Query` (returns rows) / `Command` (reports rows-affected) is the canonical CQRS read/write pair, which is exactly the split between the two. |
| `Sql.Select` | **`Sql.Selection`** | `Select` is a SQL verb; `Selection` is its noun — the structured/visual SELECT builder. |

`Sql.Query`, `Sql.Connection`, `Sql.Transaction`, `Sql.Migrations`,
`Sql.Migration` already read as nouns and keep their names.

The old names are removed; every `Sql.Exec` / `Sql.Select` usage migrates on the
same pass as the driver-kind moves. Recorded as changie `Added` (not `Removed`)
to keep `sql` pre-1.0 — see Versioning.

```yaml
# write side — formerly Sql.Exec
kind: Sql.Command
metadata: { name: DeleteUser }
connection: !ref Db
inputs:
  sql: !sql "DELETE FROM users WHERE id = ${{ request.params.id }}"
# → result.rowCount = rows affected
---
# structured read — formerly Sql.Select
kind: Sql.Selection
metadata: { name: ActiveUsers }
connection: !ref Db
from: users
columns: [id, name, email]
where:
  - { column: status, op: eq, value: active }
orderBy:
  - { column: created_at, direction: desc }
limit: 50
```

## End-state layout

| Module | Package | Kinds | Driver dep |
| --- | --- | --- | --- |
| `sql` (core) | `@telorun/sql` | `Sql.Connection` (abstract), `Sql.Query`, `Sql.Command`, `Sql.Selection`, `Sql.Transaction`, `Sql.Migration` (deprecated), `Sql.Migrations` | `kysely` only |
| `sql-postgres` | `@telorun/sql-postgres` | `SqlPostgres.Connection` | `pg` |
| `sql-sqlite` | `@telorun/sql-sqlite` | `SqlSqlite.Connection` | `better-sqlite3` (+ node/bun built-ins) |

Backends depend on `@telorun/sql` for the connection **contract**; core depends
on no driver. No telo import cycle — backends `imports: { Sql: ../sql }`; core
never imports a backend.

---

## Resource examples

### `Sql.Connection` (abstract) — unchanged, stays in core

```yaml
kind: Telo.Abstract
metadata: { name: Connection }
capability: Telo.Provider
```

The contract every driver implements; operations reference it via
`x-telo-ref: "std/sql#Connection"`. Body unchanged by the split.

### `Sql.Query` / `Sql.Command` / `Sql.Selection` / `Sql.Transaction` / `Sql.Migrations` — stay in core

All operations stay in core and keep referencing the abstract, so they work
against any backend (`Command` / `Selection` are the renamed `Exec` / `Select`):

```yaml
kind: Sql.Query
metadata: { name: GetUser }
connection: !ref Db          # any SqlPostgres.Connection / SqlSqlite.Connection
inputs:
  sql: !sql "SELECT id, name FROM users WHERE id = ${{ request.params.id }}"
```

No schema or controller change — only the *instance* `Db` now comes from a
backend module instead of `Sql.PostgresConnection`.

### `SqlPostgres.Connection` (new) — in `sql-postgres`

`metadata.name: Connection`, aliased `SqlPostgres.Connection`. Schema is the
current `Sql.PostgresConnection` schema verbatim (connectionString + pool).

```yaml
# modules/sql-postgres/telo.yaml
kind: Telo.Library
metadata: { name: sql-postgres, namespace: std, version: 0.1.0 }
imports:
  Sql: ../sql
exports:
  kinds: [Connection]
---
kind: Telo.Definition
metadata: { name: Connection }
capability: Telo.Provider
extends: Sql.Connection
controllers:
  - pkg:npm/@telorun/sql-postgres@0.1.0?local_path=./nodejs#connection
schema:
  type: object
  required: [connectionString]
  properties:
    connectionString: { type: string, title: Connection String }
    pool:
      type: object
      properties:
        min: { type: integer, default: 1 }
        max: { type: integer, default: 10 }
        idleTimeoutMs: { type: integer }
        connectionTimeoutMs: { type: integer }
  examples:
    - connectionString: postgres://user:pass@localhost:5432/db?sslmode=require
```

Usage:

```yaml
imports:
  Sql: std/sql@0.10.0
  SqlPostgres: std/sql-postgres@0.1.0
---
kind: SqlPostgres.Connection
metadata: { name: Db }
connectionString: !cel secrets.databaseUrl
---
kind: Sql.Query
metadata: { name: GetUser }
connection: !ref Db
inputs: { sql: "SELECT 1" }
```

### `SqlSqlite.Connection` (new) — in `sql-sqlite`

```yaml
# modules/sql-sqlite/telo.yaml
kind: Telo.Library
metadata: { name: sql-sqlite, namespace: std, version: 0.1.0 }
imports:
  Sql: ../sql
exports:
  kinds: [Connection]
---
kind: Telo.Definition
metadata: { name: Connection }
capability: Telo.Provider
extends: Sql.Connection
controllers:
  - pkg:npm/@telorun/sql-sqlite@0.1.0?local_path=./nodejs#connection
schema:
  type: object
  properties:
    file:
      type: string
      title: File
      description: SQLite file path; omit or use ":memory:" for in-memory.
  examples:
    - file: ./data.db
    - file: ":memory:"
```

```yaml
kind: SqlSqlite.Connection
metadata: { name: Db }
file: ":memory:"
```

---

## Code moves (the central refactor)

The driver-agnostic behaviour stays in core; only dialect construction moves out.

**Core `@telorun/sql`** keeps and **invert-refactors** `SqlConnectionResource`:
its constructor currently builds the kysely dialect (importing `pg` /
`better-sqlite3`). Change it to accept a **pre-built** `Kysely<any>` (+ optional
`SqliteDb` handle) and keep all transport-neutral methods unchanged:
`execute` / `executeTemplate` / `executeScript` / `transaction` /
`placeholderStyle` / `init` / `teardown`. Core then depends only on `kysely`.

- Stays in core: `sql-connection-controller.ts` (the agnostic class + factory),
  `sql-connection-ref.ts`, `transaction-store.ts`, all operation controllers,
  `sql-run.ts`. Rename the two renamed kinds' controllers/exports to match —
  `sql-exec` → `sql-command`, `sql-select` → `sql-selection`. The old package
  exports are dropped (no alias kinds).
- → `sql-postgres/nodejs/src/connection-controller.ts`: builds `PostgresDialect`
  + `Pool` (the current lines 45–63), owns `pg`, calls core's factory with
  `{ driver: "postgres", db }`.
- → `sql-sqlite/nodejs/src/connection-controller.ts`: builds the sqlite dialect,
  owns `better-sqlite3` + moves `sqlite-driver-bun.ts`, `sqlite-driver-node.ts`,
  `sqlite-driver-interface.ts`, `openSqliteDatabase`, and the `./sqlite-driver`
  subpath export.

**Factory boundary:** core exposes
`createSqlConnection({ driver, db, sqlite? }): SqlConnectionResource`; each
backend controller constructs its dialect, then calls it. Placeholder style is
derived from `driver` (already the case).

## Connection contract export (also the pgvector prerequisite)

Core currently has **no `.` barrel** — `package.json#exports` lists only
controller subpaths, so no third module can import the connection contract. Add
a public surface (this is the §2a prerequisite the vector-store work also needs):

```jsonc
"exports": {
  ".": { "types": "./dist/index.d.ts", "bun": "./src/index.ts", "import": "./dist/index.js" },
  "./connection": { ... },   // SqlConnectionResource + factory for backends
  // …existing controller subpaths…
}
```

`index.ts` re-exports: `SqlConnectionResource`, `createSqlConnection`,
`resolveSqlConnection`, `SqlDriver`, `SqlConnectionConfig`, `PlaceholderStyle`.
Backends import the factory; `vector-store-pgvector` imports
`resolveSqlConnection` + the contract to run vector SQL through a shared
connection.

## Strict connection ref (downstream — for `vector-store-pgvector`)

**Hard requirement:** a pgvector Store must accept **only** a Postgres
connection, and a wired-in `SqlSqlite.Connection` must be a **static analysis
failure** (`telo check`), never an init-time or runtime error. This is the whole
reason the split exists — it gives `SqlPostgres.Connection` a concrete kind the
analyzer can pin the ref to. Refs are always statically known (`!ref`), so the
analyzer has everything it needs to reject the mismatch before the kernel boots.

The pgvector Store's `connection` ref therefore targets the **concrete** kind,
not the abstract:

```yaml
connection:
  x-telo-ref: "std/sql-postgres#Connection"   # concrete, not std/sql#Connection
```

No special annotation is needed — the analyzer already enforces this. A ref
whose target is a **concrete** kind requires the referenced instance's kind to
**equal it exactly** (`checkKind` in `analyzer/nodejs/src/validate-references.ts`
— abstract targets match any implementation via `getByExtends`; concrete targets
use `resolved === targetKind`). So `x-telo-ref: "std/sql-postgres#Connection"`
rejects a `SqlSqlite.Connection` statically as a kind-mismatch
`INVALID_REFERENCE`. This holds because `SqlSqlite.Connection` does **not**
`extend` `SqlPostgres.Connection` — they're siblings under the `Sql.Connection`
abstract, and the exact-match branch does no subtype walk. No
`connection.driver === "postgres"` runtime assertion is needed, since the
mismatch can never get past `telo check`.

### Worked example

Two connections in scope — a Postgres and a SQLite — and two Stores wiring each:

```yaml
imports:
  SqlPostgres: std/sql-postgres@0.1.0
  SqlSqlite: std/sql-sqlite@0.1.0
  VectorStorePgvector: std/vector-store-pgvector@0.1.0
---
kind: SqlPostgres.Connection
metadata: { name: Pg }
connectionString: !cel secrets.databaseUrl
---
kind: SqlSqlite.Connection
metadata: { name: Lite }
file: ":memory:"
---
kind: VectorStorePgvector.Store      # ✓ valid — Pg is a SqlPostgres.Connection
metadata: { name: Vectors }
connection: !ref Pg
table: documents
dimensions: 1536
---
kind: VectorStorePgvector.Store      # ✗ static error — Lite is the wrong driver
metadata: { name: BadVectors }
connection: !ref Lite
table: documents
dimensions: 1536
```

`telo check` fails before the kernel ever boots:

```
✗ INVALID_REFERENCE  BadVectors.connection
    !ref Lite resolves to kind 'SqlSqlite.Connection', but this slot requires
    'std/sql-postgres#Connection'. Wire a SqlPostgres.Connection.

  modules/.../manifest.yaml:24
       connection: !ref Lite
                        ^^^^
```

`Vectors` passes; `BadVectors` is rejected statically — the diagnostic points at
the exact ref slot in YAML, never a stack trace at init. (Exact code/message are
the pgvector plan's to finalize; the shape is the standard reference-validation
diagnostic.)

## Migration impact

`Sql.PostgresConnection` / `Sql.SqliteConnection` appear in **19 manifests**:
`sql-repository` (telo.yaml + test), `apps/registry`, four `examples/*`, the
`sql` module tests, and several `tests/__fixtures__`. Each needs the import
added (`SqlPostgres` / `SqlSqlite`) and the kind renamed. The CLI
`upgrade`/`install` tooling can rewrite imports, but the kind rename
(`Sql.PostgresConnection` → `SqlPostgres.Connection`) is a manifest edit.

`sql-repository` only references `std/sql#Connection` (the abstract) in its
schema — **unaffected**; its *examples* using the concrete kind get updated.

The **renames** (`Sql.Exec` → `Sql.Command`, `Sql.Select` → `Sql.Selection`)
additionally touch every `Sql.Exec` / `Sql.Select` usage — migrated in the same
`upgrade` pass. No aliases, so these are required edits, not opt-in.

## Versioning

This is a **clean break**: the driver kinds move out of core and the operations
are renamed, with no deprecated aliases. The 19 manifests migrate in the same
pass.

Semantically that removes/renames kinds, but `sql` is pre-1.0 and a spurious
**1.0.0** bump is undesirable, so the change is recorded as changie **`Added`**
(new split modules + renamed kinds + the contract export), **not `Removed`**.
Mechanically: keep the `@telorun/sql` changeset at **`minor`** — never `major`.
`version-packages.mjs` maps a minor npm bump to an `Added` changie fragment, so
`metadata.version` bumps minor and the `check-no-major-module-bump` guard passes.
The kinds genuinely retire (consumers must migrate); we just decline the major
the `Removed` kind would otherwise force.

## Test plan

- Move the existing `sql` connection tests' instances to the backend kinds and
  rename `Sql.Exec` / `Sql.Select` usages to `Sql.Command` / `Sql.Selection`.
- `sql-sqlite/tests/` — in-memory roundtrip (insert/select), reusing the current
  `can-insert-and-select` body against `SqlSqlite.Connection`.
- `sql-postgres/tests/` — gated on a `DATABASE_URL`; a connect + `SELECT 1`
  smoke. Keep the bulk of operation tests in `sql` core against `sql-sqlite`
  (no external service needed).

## Docs plan

- Update `modules/sql/README.md` to describe the core/backends split and the
  contract export.
- New `modules/sql-postgres/README.md` + `modules/sql-sqlite/README.md` (+ a
  `docs/` page per connection kind), wired into `pages/sidebars.ts` under
  Storage & Data → SQL (the `docInclude` array is auto-derived from sidebars).

## Versioning checklist

- New packages `@telorun/sql-postgres`, `@telorun/sql-sqlite` → one changeset
  (minor / `Added`).
- New modules → `changie new --project sql-postgres` / `sql-sqlite`; re-run
  `scripts/gen-changie-config.mjs` (registers the ledgers).
- `@telorun/sql` core change (contract export + dialect inversion + driver-kind
  removal + operation renames) → changeset at **`minor`** (never `major`), so it
  records as `Added` and stays pre-1.0 (see Versioning).
