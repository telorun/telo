# Changelog

## 0.5.0 - 2026-09-07
### Added
* `DurableLocal.Result` reports `replayed` and `replayedSteps` — whether the attempt that finished the work continued an interrupted one, and how many steps it was handed from the record rather than executing. Recorded on the run because that is the only place the fact can live: a start returns before the first step has run, so the process that made the call is routinely gone by the time the run ends. Both are absent, never false, for work settled before this shipped. Its result envelope is closed to match `Status`'s, and declares `result` rather than leaving it to an open object, so a typo below it is an error on its own line instead of a blank at runtime. The Postgres journal adds the column to a table that already exists: it reads `information_schema` first and issues the `ALTER` only for a column genuinely absent, so a boot against an up-to-date table takes no exclusive lock on the runs table, and tolerates another instance adding it at the same moment — the SQLSTATE an ALTER loses that race with is not one a CREATE produces.

## 0.3.0 - 2026-08-23
### Added
* Controllers return their effects from `init()` / `run()` instead of implementing `teardown()`: each allocation is written beside the inverse that undoes it, and the runtime unwinds them last-in-first-out. A failure part-way through startup now recovers what it already allocated — a bound port releases the kernel hold and unregisters the routes, a connection that fails its health check destroys its pool — and the retry starts from a freshly constructed resource. Declares `requires: telo: '>=0.82.0'`, since an older runtime discards what a controller returns and would allocate nothing.

## 0.2.0 - 2026-08-20
### Added
* New: durable runs recorded in PostgreSQL. Two tables, keyed so a duplicate step record is refused by the database rather than written twice; claiming is one conditional UPDATE, so two pollers never both take a run; waking is LISTEN/NOTIFY, so a delivery reaches a poller in milliseconds instead of at its next interval. Because it can write into the same transaction as the work it records, a transactional region is journaled step by step rather than collapsed — the exactly-once regime no journal on separate storage can offer.
