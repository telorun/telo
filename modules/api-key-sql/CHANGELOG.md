# Changelog

## 0.2.1 - 2026-11-08
### Fixed
* Documentation links now point at telo.run pages and hub module pages instead of the repository tree.

## 0.2.0 - 2026-11-06
### Added
* New module: durable API-key storage in a table of the application's own database, shared by every replica. ApiKeySql.Store (abstract, extends ApiKey.Store: connection, schema, table, name, retention) stores only each key's SHA-256 digest, looks a key up with one read, lists an owner's keys with a cursor, revokes idempotently, rotates in one transaction and records last use with one conditional write per interval. Nothing is cached, so a revocation holds on every replica at the next request. A key revoked or expired longer ago than retention reads as unknown from every method on the database's clock; its row is deleted by a background sweep in bounded, lock-skipping batches that starts at the store's first call. Two stores with one name in one table are refused (API_KEY_STORE_NAME_DUPLICATE / ERR_API_KEY_STORE_NAME_DUPLICATE).
