# Queue

`queue` — durable typed work queues for background jobs. An application
enqueues a message, and a worker runs a handler for it: under a renewed lease,
with a timeout per attempt, re-attempting failures with backoff and
dead-lettering what cannot be processed. Which storage holds the messages is a
separate resource the kinds name by reference, provided by a backend module.

The module is named `Queues` and is conventionally imported as `Queue`, so its
kinds read `Queue.Queue`, `Queue.Worker` and so on. Every example here uses that
alias. (A library cannot declare a kind named like itself — `KvStore` and its
`KvStore.Store` follow the same pattern.)

```yaml
imports:
  Queue: oci://ghcr.io/telorun/queue@0.1.0
```

## Why use this

- **Survives crashes.** An enqueue that returned has stored the message; it
  outlives any process and is kept until it is settled.
- **At-least-once delivery, with the duplicate's effects made harmless.** A
  message may reach its handler more than once; a handler whose effects live in
  a database records `delivery.messageId` in the same transaction as the effects
  (`IdempotencySql.Once`), so they are committed once per message id.
- **Retries decided once, everywhere.** Exponential backoff, a wait the failure
  names (`retryAfter`), codes that are never re-attempted (`nonRetryable`), a
  timeout per attempt and a dead-letter handler — the same on every backend.
- **Typed.** A message is checked against the queue's `messageType` where it is
  enqueued — statically for a literal, by the contract for a computed one — and
  inside the handler `message` is typed from it.
- **Addressable when you need it.** On an addressable queue an id names at most
  one message: a repeated enqueue stores nothing, and a message can be looked
  up, listed, cancelled and requeued by id.
- **Traced end to end.** A delivery span continues the trace the message was
  enqueued in.

## Kinds

| Name | What it is |
| --- | --- |
| `Queue.Queue` | Abstract: one durable typed queue. A backend provides a kind extending it. Fields: `messageType` (required), `maxMessageBytes`. |
| `Queue.AddressableQueue` | Abstract, extends `Queue.Queue`: ids name messages. Adds `retention` (required). |
| [`Queue.Enqueue`](docs/operations.md#queueenqueue) | Add one message. `{ message, id?, after? }` → `{ id, enqueued }`. |
| [`Queue.EnqueueMany`](docs/operations.md#queueenqueuemany) | Add up to 1000 messages in one round trip. `{ messages }` → `{ messages: [{ id, enqueued }] }`. |
| [`Queue.Worker`](docs/delivery.md) | A Service: claims messages and runs a handler for each. |
| [`Queue.Stats`](docs/operations.md#queuestats) | Counts per state and the oldest pending message's age. |
| [`Queue.Status`](docs/operations.md#queuestatus) | One message by id (addressable). |
| [`Queue.List`](docs/operations.md#queuelist) | A page of messages in one state (addressable). |
| [`Queue.Cancel`](docs/operations.md#queuecancel) | Cancel a message by id (addressable). |
| [`Queue.Requeue`](docs/operations.md#queuerequeue) | Bring a dead message back (addressable). |
| `Queue.GroupBy` | The shape of a backend's `groupBy` field: messages of one group delivered in order. |
| `Queue.EnqueueItem` | The shape of one message to enqueue. |

## Example

An order queue on a backend's addressable kind (`Backend.Queue` stands for the
queue kind of whichever storage module you use), a route enqueueing an order,
and a worker fulfilling it.

```yaml
kind: Telo.JsonSchema
metadata: { name: Order }
schema:
  type: object
  required: [orderId, customerId]
  properties:
    orderId: { type: string }
    customerId: { type: string }
---
kind: Backend.Queue
metadata: { name: orders }
messageType: !ref Order
retention: 168h
# ...the backend's own fields
---
kind: Queue.Enqueue
metadata: { name: enqueueOrder }
queue: !ref orders
---
kind: Queue.Worker
metadata: { name: fulfilment }
queue: !ref orders
concurrency: 4
timeout: 2m
invoke: !ref fulfilOrder
inputs:
  orderId: !cel "message.orderId"
  messageId: !cel "delivery.messageId"
retry:
  attempts: 5
  initialDelay: 1s
  nonRetryable: [ERR_ORDER_INVALID]
onDead:
  invoke: !ref parkOrder
  inputs:
    orderId: !cel "message != null ? message.orderId : null"
    reason: !cel "error.code"
```

A step enqueues with `invoke: !ref enqueueOrder` and
`inputs: { id: !cel "request.body.orderId", message: !cel "request.body" }`.

## Docs

- [Delivery semantics](docs/delivery.md) — the outcomes, retries, dead messages,
  shutdown and ordering.
- [Operations](docs/operations.md) — every operation's inputs, outputs and codes.
- [Transactional outbox](docs/transactional-outbox.md) — sending to another
  system only when your transaction commits.
- [Receiving webhooks](docs/receiving-webhooks.md) — acknowledging a provider's
  event once it is stored, deduplicated by its id.
- [Store contract](docs/store-contract.md) — what a backend implements.
