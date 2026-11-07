# API keys — PostgreSQL

Keep API keys in a PostgreSQL table beside the application's own data, so every replica sees an issued, revoked or rotated key at its next request. This is the PostgreSQL engine of [`api-key-sql`](https://hub.telo.run/module/oci/ghcr.io/telorun/api-key-sql/), which owns the contract and the implementation; this module adds the table and store kinds.

## Why use this

- **Revocation holds everywhere at once** — nothing is cached, so a key revoked through one replica is refused by all the others at their next request.
- **Digests only** — a dump of the table yields no usable key.
- **One table, many stores** — any number of stores share a table under different names; two claiming one name are refused by `telo check` and at start.
- **Declared storage** — the table is a resource you declare and list in the `PostgreSQL.Schema`, which creates and migrates it. The module issues no DDL.
- **Forgets ended keys** — a key revoked or expired longer ago than `retention` reads as unknown and is deleted in the background.

## Kinds

| Kind | Capability | Purpose |
| --- | --- | --- |
| `ApiKeyPostgres.Table` | Provider | A `PostgreSQL.Table` holding the keys: `table` (the physical name). Every column and index is internal. |
| `ApiKeyPostgres.Store` | Provider | One named store: `connection` (a `PostgreSQL.Connection`), `schema` (a `PostgreSQL.Schema`), `table` (a `Table`), `name`, `retention`, `prefix`, `scopes`, `maxLifetime`. |

## Example

```yaml
imports:
  PostgreSQL: oci://ghcr.io/telorun/postgres@<version>
  ApiKey: oci://ghcr.io/telorun/api-key@<version>
  Keys: oci://ghcr.io/telorun/api-key-postgres@<version>
targets:
  - !ref appSchema
---
kind: Keys.Table
metadata: { name: apiKeys }
table: api_keys
---
kind: PostgreSQL.Schema
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

- [PostgreSQL specifics](./docs/postgres.md) — the table, instants and concurrency on this engine.
- [The SQL store](https://hub.telo.run/module/oci/ghcr.io/telorun/api-key-sql/) — retention, the sweep and atomicity.
