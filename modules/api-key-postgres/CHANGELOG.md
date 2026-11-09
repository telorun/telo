# Changelog

## 0.2.2 - 2026-11-09
### Fixed
* The telo requirement that static checking cannot see is now a `restrictions:` entry carrying its reason, and `requires.telo` holds the measured floor.

## 0.2.1 - 2026-11-08
### Fixed
* Documentation links now point at telo.run pages and hub module pages instead of the repository tree.

## 0.2.0 - 2026-11-06
### Added
* New module: the PostgreSQL engine of the SQL API-key store. ApiKeyPostgres.Table (a Postgres.Table whose columns and indexes are the store's own, listed in the Postgres.Schema that creates it) and ApiKeyPostgres.Store (connection, schema, table, name, retention, prefix, scopes, maxLifetime); sweeps from any number of processes skip each other's locked rows. Two stores with one name in one table are refused by telo check (API_KEY_STORE_NAME_DUPLICATE) and at start.
