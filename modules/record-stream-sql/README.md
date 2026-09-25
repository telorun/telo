# Record Stream SQL

A durable store for `RecordStream.Journal`: a replay journal's records kept in two tables on a database you already run, so a reader can resume a detached stream after a restart, or from another process on the same database. Works on any `Sql.Connection` whose backend renders the database clock (`renderCurrentTimeMillis` on its dialect) and accepts `INSERT … ON CONFLICT … DO NOTHING`; a connection whose backend predates the clock member is refused at start-up with `ERR_INVALID_VALUE`.

## Kinds

| Kind | Purpose |
| --- | --- |
| `RecordStreamSql.JournalStore` | A `RecordStream.JournalStore` over a `Sql.Connection`. |

## Fields

| Field | Default | Meaning |
| --- | --- | --- |
| `connection` | required | The `Sql.Connection` the journal lives in. |
| `table` | `record_stream_journal` | Table holding the records; the per-key table is `<table>_keys`. Use distinct tables for journals sharing a database. |
| `createTable` | `true` | Create both tables at start-up if missing. Set `false` when migrations own them. |
| `pollInterval` | 250ms | How often a waiting reader checks for a record another process appended; it is woken within two intervals. Must be positive (`RECORD_STREAM_SQL_POLL_INTERVAL_NOT_POSITIVE`). |

## Example

```yaml
kind: Telo.Application
metadata: { name: Turns }
imports:
  RecordStream: oci://ghcr.io/telorun/record-stream@<version>
  RecordStreamSql: oci://ghcr.io/telorun/record-stream-sql@<version>
  SQLite: oci://ghcr.io/telorun/sqlite@<version>
---
kind: SQLite.Connection
metadata: { name: db }
file: /var/lib/app/turns.db
---
kind: RecordStream.Journal
metadata: { name: turns }
store:
  kind: RecordStreamSql.JournalStore
  connection: !ref db
retention: 24h
```

The journal itself — sinks, sources, removal, expiry, reader states and writer liveness — is documented in [record-stream](../record-stream/README.md).

## Tables, clocks and polling

With `createTable: false`, create the two tables yourself:

```sql
CREATE TABLE record_stream_journal_keys (
  journal_key TEXT PRIMARY KEY,
  header TEXT NOT NULL,
  version TEXT NOT NULL,
  written_at BIGINT NOT NULL,
  last_id BIGINT NOT NULL
);
CREATE TABLE record_stream_journal (
  journal_key TEXT NOT NULL,
  id BIGINT NOT NULL,
  record TEXT NOT NULL,
  PRIMARY KEY (journal_key, id)
);
CREATE INDEX record_stream_journal_keys_written_at
  ON record_stream_journal_keys (written_at, journal_key);
```

Every conditional write is guarded by the row's version in the database, and the writes that touch both tables run as one transaction, so any number of processes can share a store. Ages are measured on the database's clock, not each host's. A record written through the same store wakes its readers at once; one written by another process is seen at the next poll.

Details: [docs/sql-journal-store.md](docs/sql-journal-store.md).
