# API keys — SQLite

Keep API keys in a SQLite table beside the application's own data, so every replica sees an issued, revoked or rotated key at its next request. This is the SQLite engine of [`api-key-sql`](../api-key-sql/README.md), which owns the contract and the implementation; this module adds the table and store kinds.

## Why use this

- **Revocation holds everywhere at once** — nothing is cached, so a key revoked through one replica is refused by all the others at their next request.
- **Digests only** — a dump of the table yields no usable key.
- **One table, many stores** — any number of stores share a table under different names; two claiming one name are refused by `telo check` and at start.
- **Declared storage** — the table is a resource you declare and list in the `SQLite.Schema`, which creates and migrates it. The module issues no DDL.
- **Forgets ended keys** — a key revoked or expired longer ago than `retention` reads as unknown and is deleted in the background.

## Kinds

| Kind | Capability | Purpose |
| --- | --- | --- |
| `ApiKeySqlite.Table` | Provider | A `SQLite.Table` holding the keys: `table` (the physical name). Every column and index is internal. |
| `ApiKeySqlite.Store` | Provider | One named store: `connection` (a `SQLite.Connection`), `schema` (a `SQLite.Schema`), `table` (a `Table`), `name`, `retention`, `prefix`, `scopes`, `maxLifetime`. |

## Example

```yaml
imports:
  SQLite: oci://ghcr.io/telorun/sqlite@<version>
  ApiKey: oci://ghcr.io/telorun/api-key@<version>
  Keys: oci://ghcr.io/telorun/api-key-sqlite@<version>
targets:
  - !ref appSchema
---
kind: Keys.Table
metadata: { name: apiKeys }
table: api_keys
---
kind: SQLite.Schema
metadata: { name: appSchema }
connection: !ref db
tables: [!ref apiKeys]
---
kind: Keys.Store
metadata: { name: keyStore }
connection: !ref db
schema: !ref appSchema
table: !ref apiKeys
name: main
prefix: sk
scopes: [read, write]
retention: 720h
---
kind: ApiKey.Verifier
metadata: { name: apiKeys }
sources: [!ref keyStore]
```

Import this module under an alias other than `ApiKey`, which is the `api-key` module's own name. Issue, list, revoke and rotate keys with `ApiKey.Issue`, `ApiKey.List`, `ApiKey.Revoke` and `ApiKey.Rotate` naming the store.

## Docs

- [SQLite specifics](./docs/sqlite.md) — the table, instants and concurrency on this engine.
- [The SQL store](../api-key-sql/docs/sql-store.md) — retention, the sweep and atomicity.
