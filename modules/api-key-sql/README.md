# API keys — SQL

Keep API keys in a table of the application's own database, so every replica sees an issued, revoked or rotated key at its next request. This is the SQL family's shared half: the `Store` contract and the engine-neutral implementation of [`api-key`](../api-key/README.md)'s store interface. Declare a store with an engine module — [`api-key-postgres`](../api-key-postgres/README.md) or [`api-key-sqlite`](../api-key-sqlite/README.md).

## Why use this

- **Revocation holds everywhere at once** — nothing is cached; every request reads the key from the table, so a key revoked through one replica is refused by all the others at their next request.
- **Digests only** — the table holds each key's SHA-256 as base64url, never the key. A dump of the table yields no usable key.
- **One table, many stores** — any number of stores share a table under different names; two claiming one name are refused by `telo check` and at start.
- **Forgets what it no longer needs** — a key revoked or expired longer ago than `retention` reads as unknown, and its row is deleted in the background in small batches.
- **Checked before boot** — a plain table that lacks the store's columns is refused by `telo check`.

## Kinds

| Kind | Capability | Purpose |
| --- | --- | --- |
| `ApiKeySql.Store` | Provider (abstract) | A durable key store: `connection`, `schema`, `table`, `name`, `retention`, plus `prefix`, `scopes` and `maxLifetime` from `ApiKey.Store`. Implemented by each engine module's `Store`. |

## Docs

- [The SQL store](./docs/sql-store.md) — retention, the background sweep, atomicity and the table layout.
