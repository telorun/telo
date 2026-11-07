# Idempotency — SQLite

Record idempotency keys in a SQLite table beside the work they guard, so a retried or redelivered operation's writes happen **once per key**. This is the SQLite engine of [`idempotency-sql`](https://hub.telo.run/module/oci/ghcr.io/telorun/idempotency-sql/), which owns the contract, the `Once` operation and the implementation; this module adds the table and ledger kinds.

## Why use this

- **Committed once per key** — the key commits or rolls back with the caller's transaction, so a redelivery after a commit skips the work and one after a rollback runs it.
- **One table, many ledgers** — any number of ledgers share a table under different names; two claiming one name are refused by `telo check` and at start.
- **Declared storage** — the table is a resource you declare and list in the `SQLite.Schema`, which creates and migrates it. The module issues no DDL.
- **Cleans up after itself** — a running ledger removes expired keys in small background batches.

## Kinds

| Kind | Capability | Purpose |
| --- | --- | --- |
| `IdempotencySqlite.Table` | Provider | A `SQLite.Table` holding ledger keys: `table` (the physical name). Every column and index is internal. |
| `IdempotencySqlite.Ledger` | Service | One named ledger: `connection` (a `SQLite.Connection`), `schema` (a `SQLite.Schema`), `table` (a `Table`), `name`, `retention`. |

## Example

```yaml
imports:
  SQLite: oci://ghcr.io/telorun/sqlite@<version>
  IdempotencySql: oci://ghcr.io/telorun/idempotency-sql@<version>
  Idempotency: oci://ghcr.io/telorun/idempotency-sqlite@<version>
targets:
  - !ref appSchema
---
kind: SQLite.Connection
metadata: { name: db }
file: !cel "variables.dbFile"
---
kind: Idempotency.Table
metadata: { name: idempotencyKeys }
table: idempotency_keys
---
kind: SQLite.Schema
metadata: { name: appSchema }
connection: !ref db
tables: [!ref idempotencyKeys]
---
kind: Idempotency.Ledger
metadata: { name: ledger }
connection: !ref db
schema: !ref appSchema
table: !ref idempotencyKeys
name: orders
retention: 168h
```

Guard work with `IdempotencySql.Once` inside a `Sql.Transaction` on `db`; see [the ledger guide](https://hub.telo.run/module/oci/ghcr.io/telorun/idempotency-sql/).

## Docs

- [SQLite specifics](./docs/sqlite.md) — the table, instants and concurrency on this engine.
