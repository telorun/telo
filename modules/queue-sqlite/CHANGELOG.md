# Changelog

## 0.3.1 - 2026-11-08
### Fixed
* Documentation links now point at telo.run pages and hub module pages instead of the repository tree.

## 0.2.0 - 2026-11-04
### Added
* New module: the SQLite engine of the SQL work queue. QueueSqlite.Table (a SQLite.Table whose columns and indexes are all the queue's, the author naming only the table) and QueueSqlite.Queue (connection, schema and table narrowed to SQLite's kinds). Workers poll for messages.
