# Queue — SQL

Durable work queues kept in a table of the application's own database. Because the queue lives beside your data, a message can be enqueued **in the same transaction** as the rows it is about — the transactional outbox: a rollback discards both, a commit keeps both. This is the SQL family's shared half: the `Queue` contract, the transactional `Enqueue` / `EnqueueMany` operations and the engine-neutral store. Declare a queue with an engine module — [`queue-postgres`](https://hub.telo.run/module/oci/ghcr.io/telorun/queue-postgres/) or [`queue-sqlite`](https://hub.telo.run/module/oci/ghcr.io/telorun/queue-sqlite/) — and process it with the [`queue`](https://hub.telo.run/module/oci/ghcr.io/telorun/queue/) module's `Queue.Worker`.

## Why use this

- **Transactional outbox** — `QueueSql.Enqueue` stores the message inside the transaction the caller has open on the queue's connection. A worker never sees a message whose data rolled back, and never misses one whose data committed. `telo check` refuses an enqueue that is not inside such a transaction.
- **Competing consumers that do not block each other** — any number of workers in any number of processes claim from one queue; a claim passes over rows another claimer holds.
- **Everything the queue module promises** — leases, at-least-once delivery, retries with backoff stored as a visibility time on the database's clock, delayed messages, dead-lettering, `Status` / `List` / `Stats` / `Cancel` / `Requeue`, deduplication by id within `retention`, and per-group ordering with `groupBy`.
- **Declared storage** — the table is a resource you declare and list in the engine `Schema`, which creates and migrates it. The module issues no DDL; several queues share one table under different names.
- **Cleans up after itself** — completed and cancelled messages past `retention` are removed in small batches by the workers' own claims. Dead messages are kept until requeued or cancelled.

Delivery is at-least-once. A handler whose effects live in the same database makes them happen once per message by recording `delivery.messageId` in the same transaction as the effects — [`IdempotencySql.Once`](https://hub.telo.run/module/oci/ghcr.io/telorun/idempotency-sql/).

## Kinds

| Kind | Capability | Purpose |
| --- | --- | --- |
| `QueueSql.Queue` | Provider (abstract) | A queue in a table: `connection`, `schema`, `table`, `name`, plus the queue module's `messageType`, `maxMessageBytes`, `retention` and an optional `groupBy`. Implemented by each engine module's `Queue`. |
| `QueueSql.Enqueue` | Invocable | `Queue.Enqueue` inside the caller's open transaction on the queue's connection. |
| `QueueSql.EnqueueMany` | Invocable | `Queue.EnqueueMany` (up to 1000 messages, one statement) inside the caller's open transaction. |

`Queue.Enqueue` and `Queue.EnqueueMany` work on these queues too: they join a transaction open on the queue's connection when there is one, and otherwise store the message in a transaction of their own.

## Example

```yaml
imports:
  Sql: oci://ghcr.io/telorun/sql@<version>
  Postgres: oci://ghcr.io/telorun/postgres@<version>
  Queues: oci://ghcr.io/telorun/queue@<version>
  QueueSql: oci://ghcr.io/telorun/queue-sql@<version>
  Queue: oci://ghcr.io/telorun/queue-postgres@<version>
targets:
  - !ref appSchema
  - !ref emailWorker
---
kind: Queue.Table
metadata: { name: queueMessages }
table: queue_messages
---
kind: Postgres.Schema
metadata: { name: appSchema }
connection: !ref db
tables: [!ref queueMessages, !ref orders]
---
kind: Queue.Queue
metadata: { name: emails }
connection: !ref db
schema: !ref appSchema
table: !ref queueMessages
name: emails
retention: 168h
messageType: !ref OrderEmail
---
# The order and its email commit together, or not at all.
kind: Sql.Transaction
metadata: { name: placeOrder }
connection: !ref db
inputs:
  order: !cel "inputs.order"
steps:
  kind: Run.Sequence
  steps:
    - name: insert
      invoke: !ref insertOrder
      inputs: { order: !cel "inputs.order" }
    - name: email
      invoke: { kind: QueueSql.Enqueue, queue: !ref emails }
      inputs:
        id: !cel "'order-email-' + inputs.order.id"
        message: { orderId: !cel "inputs.order.id" }
---
kind: Queues.Worker
metadata: { name: emailWorker }
queue: !ref emails
invoke: !ref sendOrderEmail
inputs:
  orderId: !cel "message.orderId"
  idempotencyKey: !cel "delivery.messageId"
timeout: 30s
retry: { attempts: 5 }
```

## Docs

- [How the SQL queue works](./docs/sql-queue.md) — the transactional enqueue, claiming, groups, retention and the purge, waking, precision, what the table holds, the refusals.
