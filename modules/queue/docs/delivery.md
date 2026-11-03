# Delivery semantics

`Queue.Worker` claims messages from a queue and runs its handler for each. Every
decision below is made by the worker, the same way on every backend; the queue's
storage only stores.

## What delivery guarantees

- **At-least-once.** A message reaches a handler at least once and may reach it
  more than once — a process can die after the handler's effects and before the
  message is settled. Make the effects harmless to repeat: a handler whose
  effects live in a database records `delivery.messageId` in the same
  transaction as the effects (`IdempotencySql.Once`), so they are committed once
  per message id. Effects outside that database (an email, a call to another
  service) are made harmless by the receiving side, given `delivery.messageId`
  as its idempotency key.
- **One consumer at a time.** A claimed message is held by one worker under a
  lease. No other consumer gets it until it is settled, handed back, or the
  lease lapses — and a worker that cannot confirm a renewal cancels its handler
  with a third of the lease still left, so it has stopped before the lease
  lapses. The margin is measured on the worker's clock, so it holds while the
  storage's and the worker's clocks advance at the same rate.
- **Never early.** A message is not delivered before its visibility time,
  measured on the queue storage's own clock — never a worker's.
- **Attempts are counted by the storage.** Every claim is an attempt, including
  one whose lease lapsed; an attempt handed back at shutdown is not counted.

## Fields

| Field | Default | Meaning |
| --- | --- | --- |
| `queue` | required | The queue messages are claimed from. |
| `invoke` | required | The handler. Its inputs are `inputs`, evaluated per delivery. |
| `inputs` | `{}` | The handler's inputs, over `message` and `delivery`. |
| `concurrency` | `1` | Messages this process handles at once. |
| `lease` | `30s` | How long a claim holds a message; renewed every third of it while the handler runs. The handler is cancelled when no renewal has been confirmed with a third of the lease left. |
| `timeout` | required | How long one attempt may run before it is cancelled. |
| `shutdownGrace` | `5s` | How long an in-flight delivery may finish when the application shuts down. |
| `retry` | required | The shared retry policy; `attempts` is required. |
| `onDead` | none | `{ invoke, inputs }`: runs before a message is marked dead. |

In `inputs`, `message` is the message, typed from the queue's `messageType`, and
`delivery` is `{ messageId, attempt, enqueuedAt }` (`attempt` is 1 on the first
delivery). In `onDead.inputs`, `message` is nullable — null when the stored body
no longer has the message type — and `error` is `{ code, message, data? }`.

Both handlers run inside a zone that forbids suspending: the lease is renewed
only while this process runs the handler, so a handler that parked would resume
after the message was redelivered elsewhere. `telo check` refuses a durable wait
inside them.

## Outcomes

| What happened | What the worker does |
| --- | --- |
| The handler returned | The message is completed — removed from a plain queue, kept for `retention` on an addressable one. |
| The handler failed, retryably, with attempts left | The message is handed back, visible again after the backoff — or after the duration `retry.retryAfter` yields for this failure. The failure is recorded as its last error. |
| A code in `retry.nonRetryable`, a contract violation (`ERR_INPUT_INVALID`, …), a target that does not resolve, or the last allowed attempt failed | `onDead` runs, then the message is marked dead. |
| The attempt ran past `timeout` | The handler is cancelled and the attempt fails with `ERR_QUEUE_TIMEOUT`, retried like any failure. |
| A claim finds the previous claim's lease lapsed | The lapse is recorded as `ERR_QUEUE_LEASE_EXPIRED` for that attempt. If that used up the budget the handler is not run: `onDead` runs, then dead. |
| The lease was lost while the handler ran | The handler is cancelled and nothing is settled; another consumer may deliver the message. |
| Renewals failed or did not answer | The worker gives the message up itself: once a third of the lease is all that remains since the start of the last renewal the storage confirmed (measured on the worker's own monotonic clock), the handler is cancelled and nothing is settled — before the lease can lapse and another consumer claim the message. Each renewal is bounded by that same moment. |
| `Queue.Cancel` was seen at a lease renewal | The handler is cancelled; the message is already settled `cancelled`. |
| The application shuts down | Claiming stops. In-flight deliveries may finish for `shutdownGrace`; what is left is cancelled and handed back at once, its attempt not counted, and the worker then waits up to 1s more for those handlers to return before it stops — a handler that ignores its cancellation is left behind with a `warn` record. |
| `onDead` failed | The message is handed back with a backoff, marked as dying: its next claim goes straight to `onDead` again. |
| The stored body does not have the `messageType` | The message is dead at once with `ERR_QUEUE_MESSAGE_INVALID`; the handler is never run, and `onDead` runs with `message: null`. |
| The queue's storage fails | The worker keeps running, backs its claims off (250ms doubling to 30s), and recovers on its own. |

Every dead-lettering writes one structured `warn` log record carrying
`telo.queue.message.id`, `telo.queue.delivery.attempt` and the failure's code as
`error.type`.

## Retries

`retry` is the shared retry policy: `attempts` re-attempts after the first try,
the n-th waiting `initialDelay × factor^(n-1)` capped by `maxDelay` (250ms and
32s when omitted), spread by `jitter: full` unless it is `none`. The wait is not
slept by the worker: it is stored as the message's visibility time, so a
re-attempt may run on any worker, and nothing is lost if this one stops.

`retryAfter` is CEL over the failure (`error`): a duration replaces the backoff
for the next attempt, capped by `maxDelay` and never jittered; `null` keeps it.
`telo check` types `error.data` against the handler's declared throws plus
`ERR_QUEUE_TIMEOUT` and `ERR_QUEUE_LEASE_EXPIRED`, and warns about a
`nonRetryable` code none of them can raise. Listing `ERR_QUEUE_LEASE_EXPIRED`
dead-letters a message the first time an attempt's lease lapses.

## Dead messages

A dead message is never delivered again and is kept — whatever the queue's
`retention`. On an addressable queue it can be found with `Queue.List`
(`state: dead`), brought back with `Queue.Requeue` once whatever made it fail is
fixed (its attempts reset), or dropped with `Queue.Cancel`.

`onDead` runs at least once before a message is marked dead: if this process
dies after `onDead` returned and before the message is marked, the next claim
runs `onDead` again.

## Ordering

A queue promises no order. A backend whose queue kind declares `groupBy` (the
`Queue.GroupBy` shape — a plain chain over `message`, such as
`!cel "message.customerId"`) delivers the messages of one group one at a time,
in enqueue order; different groups are delivered in parallel. A dead message
holds its group until it is requeued or cancelled, so later messages of the
group wait rather than overtake it.

## Tracing

Each delivery is its own span, opened in a fresh root context, carrying
`telo.queue.message.id` and `telo.queue.delivery.attempt`. When the message was
enqueued while tracing was on, the span continues that trace: the delivery is a
child of the span that enqueued it.
