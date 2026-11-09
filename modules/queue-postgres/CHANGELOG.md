# Changelog

## 0.3.2 - 2026-11-09
### Fixed
* The telo requirement that static checking cannot see is now a `restrictions:` entry carrying its reason, and `requires.telo` holds the measured floor.

## 0.3.1 - 2026-11-08
### Fixed
* Documentation links now point at telo.run pages and hub module pages instead of the repository tree.

## 0.2.0 - 2026-11-04
### Added
* New module: the PostgreSQL engine of the SQL work queue. QueuePostgres.Table (a Postgres.Table whose columns and indexes are all the queue's, the author naming only the table) and QueuePostgres.Queue (connection, schema and table narrowed to PostgreSQL's kinds). Claims use skipped row locks, and idle workers are woken by LISTEN/NOTIFY, an enqueue's notification delivered only when its transaction commits.
