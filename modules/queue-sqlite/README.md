# Queue — SQLite

Durable background-job queues in a SQLite table beside the application's own data, so a job can be enqueued in the same transaction as the rows it is about. This is the SQLite engine of [`queue-sql`](../queue-sql/README.md), which owns the contract, the transactional enqueue and the implementation; this module adds the table and queue kinds. Messages are processed by the [`queue`](../queue/README.md) module's `Queue.Worker`.

## Why use this

- **Transactional outbox on one file** — a message enqueued with `QueueSql.Enqueue` commits or rolls back with the caller's transaction.
- **Background jobs that survive a restart** — leases, retries with backoff, delays, dead-lettering, deduplication by id and per-group ordering, all kept in the database file.
- **One table, many queues** — any number of queues share a table under different names; two claiming one name are refused by `telo check` and at start.
- **Declared storage** — the table is a resource you declare and list in the `SQLite.Schema`, which creates and migrates it. The module issues no DDL.

## Kinds

| Kind | Capability | Purpose |
| --- | --- | --- |
| `QueueSqlite.Table` | Provider | A `SQLite.Table` holding queue messages: `table` (the physical name). Every column and index is internal. |
| `QueueSqlite.Queue` | Provider | One named queue: `connection` (a `SQLite.Connection`), `schema` (a `SQLite.Schema`), `table` (a `Table`), `name`, `messageType`, `retention`, optional `maxMessageBytes` and `groupBy`. |

## Example

```yaml
imports:
  SQLite: oci://ghcr.io/telorun/sqlite@<version>
  Queues: oci://ghcr.io/telorun/queue@<version>
  QueueSql: oci://ghcr.io/telorun/queue-sql@<version>
  Queue: oci://ghcr.io/telorun/queue-sqlite@<version>
targets:
  - !ref appSchema
  - !ref thumbnailWorker
---
kind: SQLite.Connection
metadata: { name: db }
file: !cel "variables.dbFile"
---
kind: Queue.Table
metadata: { name: queueMessages }
table: queue_messages
---
kind: SQLite.Schema
metadata: { name: appSchema }
connection: !ref db
tables: [!ref queueMessages]
---
kind: Queue.Queue
metadata: { name: thumbnails }
connection: !ref db
schema: !ref appSchema
table: !ref queueMessages
name: thumbnails
retention: 24h
messageType: !ref ThumbnailJob
---
kind: Queues.Worker
metadata: { name: thumbnailWorker }
queue: !ref thumbnails
invoke: !ref makeThumbnail
inputs:
  imageId: !cel "message.imageId"
timeout: 1m
retry: { attempts: 3 }
```

## Docs

- [SQLite specifics](./docs/sqlite.md) — the table, polling, instants and concurrency on this engine.
- [How the SQL queue works](../queue-sql/docs/sql-queue.md) — the transactional enqueue, claiming, groups, retention, the refusals.
