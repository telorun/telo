# Changelog

## 0.6.2 - 2026-10-04
### Fixed
* A CEL duration and uint are read through the value domain's own predicates (isCelDuration, isCelUint) rather than by class, so a value built by any copy of the engine is recognised: identity is a string type key under Symbol.for("telo.cel.value"), not a constructor.
* A duration-valued field is read again: a duration is identified by a type key and carries no methods, so these controllers read one through durationNanos and build one with celDurationFromNanos instead of naming a class the CEL value domain no longer has — which failed at resource creation with 'isCelDuration is not defined', a missing 'Duration' export, or 'value.getMilliseconds is not a function'.

## 0.4.0 - 2026-09-27
### Added
* RecordStreamSql.JournalStore reports each key's last record id as the header's lastId from read and scan, as the journal store contract now requires; the tables are unchanged.

## 0.2.0 - 2026-09-25
### Added
* New module: a durable store for RecordStream.Journal. RecordStreamSql.JournalStore keeps a replay journal in two tables on any Sql.Connection whose backend renders the database clock (the SQL dialect's renderCurrentTimeMillis) and accepts INSERT … ON CONFLICT … DO NOTHING — connection, table (default record_stream_journal, plus <table>_keys and an age index), createTable, and pollInterval (250ms when omitted) — so a reader resumes a detached stream after a restart or from another process. Conditional writes are version-guarded statements and transactions, ages use the database clock, names are quoted through the dialect, a connection whose backend predates the clock member is refused at start-up with ERR_INVALID_VALUE, and readers in other processes are woken by polling.
