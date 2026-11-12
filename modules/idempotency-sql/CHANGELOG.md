# Changelog

## 0.4.0 - 2026-11-12
### Added
* IdempotencySql.Once's forwarded inputs are typed by the body's input contract, so its sensitive marks are redacted in the claim's traces and a refused payload fails at the claim's own dispatch.

## 0.3.2 - 2026-11-09
### Fixed
* `requires.telo` now holds the measured floor, raised to the highest floor among the workspace modules this module imports.

## 0.3.1 - 2026-11-08
### Fixed
* Documentation links now point at telo.run pages and hub module pages instead of the repository tree.

## 0.3.0 - 2026-11-06
### Added
* The ledger's background sweep of expired keys now runs on the shared RowSweep from @telorun/sql; its behaviour is unchanged.
### Fixed
* `IdempotencySql.Once`'s `invoke` slot no longer claims a resource-level `inputs:` field it never had; the body's arguments still arrive through the call's `inputs`.

## 0.2.0 - 2026-11-04
### Added
* New module: the shared half of a transactional idempotency ledger for SQL databases. The Ledger abstract (a Service: connection, schema, table, name, and a positive retention) records idempotency keys in a table of the application's own database, and Once runs a body at most once per key inside a transaction the caller has open on the ledger's connection: the key is recorded beside the body's writes, so a rollback forgets it and a commit keeps it for the retention window, after which it reads as absent. A concurrent call with the same key waits for the first transaction to end. The inputs Once forwards are checked against the body's own input contract. An optional fingerprint is stored as a digest of its canonical encoding, and the same key with a different one is refused with ERR_IDEMPOTENCY_KEY_CONFLICT. Once outside a transaction on its ledger's connection is refused by telo check and at run (ERR_ZONE_REQUIRED). A ledger removes expired keys in small background batches that skip rows another transaction holds, starting from its first write or earlier when it is a boot target, and takes no hold on the process. Requires telo 0.122.0.
