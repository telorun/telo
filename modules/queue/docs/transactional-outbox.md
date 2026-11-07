# Transactional outbox

The problem: an operation writes to its database and must tell another system —
publish an event, call a webhook, send an email. Doing both in the handler is
wrong both ways round: send first and the transaction may roll back after the
other system acted; commit first and the process may die before it sends.

The outbox pattern: in the same transaction as the write, **enqueue** a message
saying what to send. A worker then sends it, re-attempting until the other system
accepts it. The send happens if and only if the write committed.

## The outbox queue

Declare the queue on a storage whose enqueue joins the transaction you have open
— a queue kept in the application's own database, on the same connection as the
write. Whether an enqueue joins an open transaction is the storage's own rule; a
storage that requires it refuses an enqueue outside one with `ERR_ZONE_REQUIRED`,
which `telo check` reports before anything runs.

```yaml
kind: Telo.JsonSchema
metadata: { name: OrderPlaced }
schema:
  type: object
  required: [orderId, total]
  properties:
    orderId: { type: string }
    total: { type: integer }
---
kind: Backend.Queue           # the queue kind of your storage module
metadata: { name: outbox }
messageType: !ref OrderPlaced
retention: 168h
---
kind: Queue.Enqueue
metadata: { name: emitOrderPlaced }
queue: !ref outbox
```

Inside the transaction, write and enqueue as two steps:

```yaml
kind: Sql.Transaction
metadata: { name: placeOrder }
connection: !ref db
steps:
  - name: insert
    invoke: !ref insertOrder
    inputs: { id: !cel "inputs.orderId", total: !cel "inputs.total" }
  - name: emit
    invoke: !ref emitOrderPlaced
    inputs:
      id: !interpolate "order-placed-${{ inputs.orderId }}"
      message: { orderId: !cel "inputs.orderId", total: !cel "inputs.total" }
```

## The sending worker

The worker's handler publishes to the destination. Delivery is at-least-once, so
it sends `delivery.messageId` as the destination's idempotency key — a broker's
message id, an HTTP `Idempotency-Key` header — and a re-delivery after a crash
is recognised there rather than acted on twice.

```yaml
kind: Queue.Worker
metadata: { name: relay }
queue: !ref outbox
timeout: 30s
invoke: !ref publishOrderPlaced
inputs:
  idempotencyKey: !cel "delivery.messageId"
  event: !cel "message"
retry:
  attempts: 10
  initialDelay: 1s
  maxDelay: 5m
```

When the destination is the **same database** — a projection, a counter, a
second table — there is no other system to deduplicate: wrap the handler's
writes in a transaction and record `delivery.messageId` in it with
`IdempotencySql.Once`, so the effects are committed once per message id.

## Enqueueing from an event handler

A library that announces a business event with `Domain.Emit` knows nothing of the queue. The application adds a `Domain.Handler` whose target is `QueueSql.Enqueue`: it runs inside the emitter's transaction, so the message is committed with the emitter's writes and lost with a rollback, and `telo check` proves the transaction through the emit. See [Work after commit](https://hub.telo.run/module/oci/ghcr.io/telorun/domain-events/) in the domain-events docs.

## Order

A queue promises no order. When the destination must see events for one entity
in the order they happened, use a storage whose queue declares `groupBy` and
group by that entity (`groupBy: !cel "message.orderId"`): one order's events are
delivered one at a time in enqueue order, different orders in parallel.
