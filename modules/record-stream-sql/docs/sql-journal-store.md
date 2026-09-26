---
description: "How RecordStreamSql.JournalStore lays a replay journal out in two SQL tables, keeps every conditional write atomic across processes, measures ages on the database clock, and wakes readers in other processes by polling."
sidebar_label: SQL journal store
---

# `RecordStreamSql.JournalStore`

A `RecordStream.JournalStore` over any `Sql.Connection` whose backend meets two requirements: its dialect renders the database clock (`renderCurrentTimeMillis`, required of every SQL dialect), and it accepts `INSERT … ON CONFLICT (…) DO NOTHING`. A connection whose backend predates the clock member is refused at start-up with `ERR_INVALID_VALUE`, before any statement. It implements the eight primitives of the [journal store contract](../../record-stream/docs/store-contract.md) and nothing else: the journal protocol (claims, heartbeats, removal, expiry, reader states) is `RecordStream.Journal`'s, above it. No statement here names a journal state; every condition is a version comparison or an age.

## Tables

Two tables per store, named by `table:` (default `record_stream_journal`). With `createTable: false` the application's own migrations create them, with these columns:

`<table>_keys` — one row per key, the header:

| Column | Type | Meaning |
| --- | --- | --- |
| `journal_key` | `TEXT PRIMARY KEY` | The key. |
| `header` | `TEXT NOT NULL` | The journal's header, an opaque typed frame. |
| `version` | `TEXT NOT NULL` | Opaque revision token; a new one on every write to the key. |
| `written_at` | `BIGINT NOT NULL` | When the header was last written, epoch milliseconds on the database clock. |
| `last_id` | `BIGINT NOT NULL` | The id of the last record appended (0 for none). |

`<table>` — one row per record:

| Column | Type | Meaning |
| --- | --- | --- |
| `journal_key` | `TEXT NOT NULL` | The key the record belongs to. |
| `id` | `BIGINT NOT NULL` | 1-based, gap-free per key. |
| `record` | `TEXT NOT NULL` | The record, an opaque typed frame. |

Primary key `(journal_key, id)`.

An index `<table>_keys_written_at` on `<table>_keys (written_at, journal_key)` serves expiry's scan, which reads keys by age, oldest first. With `createTable: false`, create it too.

`table:` is an identifier, not a bind parameter: it must match `^[A-Za-z_][A-Za-z0-9_]*$` and is quoted through the connection's dialect wherever it is used. Journals sharing one database take distinct tables.

## Atomicity

- `putIfAbsent` is one `INSERT … ON CONFLICT (journal_key) DO NOTHING`.
- `compareAndSet` is one `UPDATE … WHERE journal_key = ? AND version = ?`.
- `compareAndAppend` is one transaction: the version-guarded `UPDATE` that advances `last_id`, then the `INSERT` of the record under that id. Losing the version check changes nothing.
- `compareAndTruncate` and `compareAndDelete` are one transaction each: the version-guarded write of the header row, then the deletion of the key's records.
- `read` is one statement joining the header to the requested records, so a page is one snapshot.

Journal statements run on the connection itself and never join a transaction the application has open on it: a record about work must not be rolled back with the work.

## Clocks

Ages are `now - written_at` computed by the database, on its own clock: the expression the connection's dialect renders for the current time in epoch milliseconds, read when each statement runs. A reader in one process judges a writer in another by the same clock, so host clock skew does not make a live writer look dead.

Table and index names go through the dialect's identifier quoting.

## Waiting and polling

A reader tailing a live key waits for its version to change. A write through the same store instance wakes its readers at once. A write by another process is seen at the store's next poll: `wait` re-reads the key every `pollInterval` (250ms when omitted), so such a reader is woken within two intervals of the append. A shorter interval means faster cross-process delivery and more queries per waiting reader.

A cancelled wait — its reader's consumer stopped, or the reading invocation was cancelled — ends at once and issues no further query; a poll already in flight finishes and its answer is discarded.

## Example

```yaml
kind: SQLite.Connection
metadata: { name: db }
file: /var/lib/app/app.db
---
kind: RecordStream.Journal
metadata: { name: turns }
store:
  kind: RecordStreamSql.JournalStore
  connection: !ref db
retention: 24h
```
