# Changelog

## 0.3.1 - 2026-11-08
### Fixed
* Documentation links now point at telo.run pages and hub module pages instead of the repository tree.

## 0.2.0 - 2026-11-04
### Added
* New module: the SQLite engine of the transactional idempotency ledger. Table extends SQLite.Table with only the physical table name written by the author, every column and index internal and listed in the SQLite.Schema that creates it; Ledger narrows the connection, schema and table to SQLite's kinds. Two ledgers claiming one name in one table are refused by telo check and when the second starts (IDEMPOTENCY_LEDGER_NAME_DUPLICATE). A concurrent transaction recording the same key waits through the connection's busy timeout. Requires telo 0.122.0.
