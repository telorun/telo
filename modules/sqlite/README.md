# SQL SQLite

`SQLite.Connection` — a SQLite backend for the [`sql`](../sql/README.md) module's `Sql.Connection` abstract. Opens a file-backed or in-memory database (`better-sqlite3` on Node, `bun:sqlite` on Bun) with transactional DDL; the `sql` core itself depends on no driver.

Every `sql` operation (`Sql.Query`, `Sql.Command`, `Sql.Selection`, `Sql.Transaction`) and this module's own `Schema` kind references the connection driver-agnostically via `x-telo-ref: Sql.Connection`; this module satisfies that ref.

## Usage

```yaml
imports:
  Sql: oci://ghcr.io/telorun/sql@0.13.0
  SQLite: oci://ghcr.io/telorun/sqlite@0.1.0
---
kind: SQLite.Connection
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

## Declarative schema

`SQLite.Table` declares a table in SQLite's own vocabulary — the five storage
classes, no arrays, no namespaces — and `SQLite.Schema` brings the database to
what is declared at start-up, tombstoning removals rather than executing them.

```yaml
kind: SQLite.Table
metadata: { name: users }
table: users
columns:
  id:    { type: integer, primaryKey: true, identity: always }
  email: { type: text, nullable: false, unique: true }
---
kind: SQLite.Schema
metadata: { name: appSchema }
connection: !ref db
version: !cel "module.version"
tables: [ !ref users ]
reclaim: { afterVersions: 3, afterDuration: 30d }
```

SQLite has exactly one namespace, so unlike `Postgres.Schema` there is no
`schema:` field to name and nothing to create.

### Domains, predicates and reference data

SQLite has no named types, so a declared enum has no database object behind it:
the values are rendered as a `CHECK` on every column that references it, and the
DECLARATION is a ledger object like any other — which is what lets a change to it
be detected at all. `baseType` says which storage class the values sit in;
PostgreSQL needs no equivalent because its enum IS its own base type.

```yaml
kind: SQLite.Enum
metadata: { name: messageRole }
typeName: message_role
baseType: text
values: [system, user, assistant]
---
kind: SQLite.Table
metadata: { name: roles }
table: roles
columns:
  name: { type: text, primaryKey: true }
  role: { type: !ref messageRole, nullable: false }
checks:
  name_not_blank:
    expression: "length(name) > 0"
seeds:
  key: [name]
  rows:
    - { name: admin, role: system }
---
kind: SQLite.Schema
metadata: { name: appSchema }
connection: !ref db
version: !cel "module.version"
enums: [ !ref messageRole ]
tables: [ !ref roles ]
```

The projected row contract is identical to PostgreSQL's — same enum, same
`{ type: string, enum: [...] }` — which is the point of the split between
declaration and rendering.

**Checks and domains land where the foreign keys already are.** SQLite has no
`ADD CONSTRAINT`, so both are emitted at create time and a later change to either
is refused with the reason. The refusal needs no expression parsing: the ledger
records the declaration, so the pass compares this boot's against the recorded
one. Renaming a table uses the same statement PostgreSQL does; renaming an enum's
`typeName` emits nothing at all, because the `CHECK`s never named the type — the
ledger key rewrite IS the rename.

**What SQLite cannot do in place is refused with the reason.** There is no
`ALTER COLUMN`, and a foreign key exists only as part of the table it was created
with, so changing a column's type, its nullability or its default — or adding a
foreign key to an existing table — fails naming the table, the column and the
remedy: rebuild the table in a `migrations:` entry. Nothing is silently
unapplied.

If a second schema resource — an imported library's, or another application's —
manages tables in the same namespace, give each its own `ledger:` so their
histories stay apart; two on one connection naming the same one are refused.

See [Declarative schema](../sql/docs/declarative-schema.md) for tombstoning,
reclamation, renames, seeds and the ledger rule.
