# Changelog

## 0.3.0 - 2026-08-23
### Added
* Controllers return their effects from `init()` / `run()` instead of implementing `teardown()`: each allocation is written beside the inverse that undoes it, and the runtime unwinds them last-in-first-out. A failure part-way through startup now recovers what it already allocated — a bound port releases the kernel hold and unregisters the routes, a connection that fails its health check destroys its pool — and the retry starts from a freshly constructed resource. Declares `requires: telo: '>=0.82.0'`, since an older runtime discards what a controller returns and would allocate nothing.

## 0.2.0 - 2026-08-20
### Added
* New: durable runs recorded in PostgreSQL. Two tables, keyed so a duplicate step record is refused by the database rather than written twice; claiming is one conditional UPDATE, so two pollers never both take a run; waking is LISTEN/NOTIFY, so a delivery reaches a poller in milliseconds instead of at its next interval. Because it can write into the same transaction as the work it records, a transactional region is journaled step by step rather than collapsed — the exactly-once regime no journal on separate storage can offer.
