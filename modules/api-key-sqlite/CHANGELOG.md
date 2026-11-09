# Changelog

## 0.2.2 - 2026-11-09
### Fixed
* The telo requirement that static checking cannot see is now a `restrictions:` entry carrying its reason, and `requires.telo` holds the measured floor.

## 0.2.1 - 2026-11-08
### Fixed
* Documentation links now point at telo.run pages and hub module pages instead of the repository tree.

## 0.2.0 - 2026-11-06
### Added
* New module: the SQLite engine of the SQL API-key store. ApiKeySqlite.Table (a SQLite.Table whose columns and indexes are the store's own, listed in the SQLite.Schema that creates it) and ApiKeySqlite.Store (connection, schema, table, name, retention, prefix, scopes, maxLifetime); several application instances may share one database file. Two stores with one name in one table are refused by telo check (API_KEY_STORE_NAME_DUPLICATE) and at start.
