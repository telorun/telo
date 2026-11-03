# Queue — PostgreSQL

Durable background-job queues in a PostgreSQL table beside the application's own data, so a job can be enqueued in the same transaction as the rows it is about. Workers on any number of machines claim messages concurrently, passing over each other's locked rows, and are woken by a notification when work arrives. This is the PostgreSQL engine of [`queue-sql`](../queue-sql/README.md), which owns the contract, the transactional enqueue and the implementation; this module adds the table and queue kinds. Messages are processed by the [`queue`](../queue/README.md) module's `Queue.Worker`.

## Why use this

- **Transactional outbox** — a message enqueued with `QueueSql.Enqueue` commits or rolls back with the caller's transaction, and its wake notification is delivered only on commit.
- **Competing consumers across machines** — claims use `FOR UPDATE SKIP LOCKED`, so workers never wait on each other's rows.
- **Prompt delivery without busy polling** — an idle worker waits on `LISTEN` and claims as soon as an enqueue, a retry or a requeue makes a message ready.
- **Background jobs that survive a crash** — leases, retries with backoff, delays, dead-lettering, deduplication by id and per-group ordering.
- **Declared storage** — the table is a resource you declare and list in the `Postgres.Schema`, which creates and migrates it. The module issues no DDL.

## Kinds

| Kind | Capability | Purpose |
| --- | --- | --- |
| `QueuePostgres.Table` | Provider | A `Postgres.Table` holding queue messages: `table` (the physical name). Every column and index is internal. |
| `QueuePostgres.Queue` | Provider | One named queue: `connection` (a `Postgres.Connection`), `schema` (a `Postgres.Schema`), `table` (a `Table`), `name`, `messageType`, `retention`, optional `maxMessageBytes` and `groupBy`. |

## Example

```yaml
imports:
  Postgres: oci://ghcr.io/telorun/postgres@<version>
  Queues: oci://ghcr.io/telorun/queue@<version>
  QueueSql: oci://ghcr.io/telorun/queue-sql@<version>
  Queue: oci://ghcr.io/telorun/queue-postgres@<version>
targets:
  - !ref appSchema
  - !ref invoiceWorker
---
kind: Queue.Table
metadata: { name: queueMessages }
table: queue_messages
---
kind: Postgres.Schema
metadata: { name: appSchema }
connection: !ref db
tables: [!ref queueMessages, !ref invoices]
---
kind: Queue.Queue
metadata: { name: invoices }
connection: !ref db
schema: !ref appSchema
table: !ref queueMessages
name: invoices
retention: 168h
messageType: !ref InvoiceJob
groupBy: !cel "message.customerId"
---
kind: Queues.Worker
metadata: { name: invoiceWorker }
queue: !ref invoices
concurrency: 8
invoke: !ref issueInvoice
inputs:
  invoiceId: !cel "message.invoiceId"
  messageId: !cel "delivery.messageId"
timeout: 30s
retry: { attempts: 5, initialDelay: 1s }
```

## Docs

- [PostgreSQL specifics](./docs/postgres.md) — the table, skipped locks, notifications and instants on this engine.
- [How the SQL queue works](../queue-sql/docs/sql-queue.md) — the transactional enqueue, claiming, groups, retention, the refusals.
