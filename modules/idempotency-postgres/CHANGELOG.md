# Changelog

## 0.3.2 - 2026-11-09
### Fixed
* The telo requirement that static checking cannot see is now a `restrictions:` entry carrying its reason, and `requires.telo` holds the measured floor.

## 0.3.1 - 2026-11-08
### Fixed
* Documentation links now point at telo.run pages and hub module pages instead of the repository tree.

## 0.2.0 - 2026-11-04
### Added
* New module: the PostgreSQL engine of the transactional idempotency ledger. Table extends Postgres.Table with only the physical table name written by the author, every column and index internal and listed in the Postgres.Schema that creates it; Ledger narrows the connection, schema and table to PostgreSQL's kinds. Two ledgers claiming one name in one table are refused by telo check and when the second starts (IDEMPOTENCY_LEDGER_NAME_DUPLICATE). A concurrent transaction recording the same key waits on the ledger's unique index for the first to end, and the background sweep skips locked rows. Requires telo 0.122.0.
