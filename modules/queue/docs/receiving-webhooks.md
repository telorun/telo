# Receiving webhooks

A webhook provider retries until it gets a 2xx, and sends the same event again
on any doubt — a timeout, a 5xx, a dropped connection. The robust receiver does
as little as possible before answering: it **stores** the event, deduplicated by
the provider's event id, answers 2xx, and processes it in the background.

An addressable queue gives that. The provider's event id becomes the
message id, so a redelivered event is stored once: the second enqueue answers
`enqueued: false` and stores nothing.

```yaml
kind: Telo.JsonSchema
metadata: { name: PaymentEvent }
schema:
  type: object
  required: [type, paymentId]
  properties:
    type: { type: string }
    paymentId: { type: string }
    amount: { type: integer }
---
kind: Backend.Queue           # an addressable queue kind of your storage module
metadata: { name: paymentEvents }
messageType: !ref PaymentEvent
# At least the provider's redelivery window: an event repeated after the id
# expired would be stored again.
retention: 168h
---
kind: Http.Api
metadata: { name: webhooks }
routes:
  - request:
      path: /webhooks/payments
      method: POST
    handler:
      kind: Queue.Enqueue
      queue: !ref paymentEvents
    inputs:
      id: !cel "request.body.id"
      # Only the stable part of the event: a provider stamping each delivery
      # with its own send time would make every redelivery a different message.
      message:
        type: !cel "request.body.type"
        paymentId: !cel "request.body.data.paymentId"
        amount: !cel "request.body.data.amount"
    returns:
      # Stored now or stored before — either way the provider may stop.
      - status: 204
```

A worker on `paymentEvents` then processes each event with retries and
dead-lettering — see [delivery semantics](delivery.md).

## Choices that matter

- **Answer 2xx on either `enqueued`.** `true` stored it now, `false` stored it
  before; both mean the event is safe.
- **`retention` covers the provider's redelivery window.** Within it a repeated
  id stores nothing; after it the id is free again.
- **Enqueue the stable part.** "The same message" is compared by its canonical
  body. An event carrying a per-delivery field (a send timestamp, a signature)
  would differ on every redelivery and be refused as `ERR_QUEUE_ID_CONFLICT`.
  Enqueue only what identifies the event, or catch the code if the provider can
  legitimately change an event under one id:

  ```yaml
  catches:
    - when: !cel "error.code == 'ERR_QUEUE_ID_CONFLICT'"
      status: 204
  ```

- **Verify the signature first.** Check the provider's signature on the route
  before enqueueing, so an unsigned request stores nothing.
