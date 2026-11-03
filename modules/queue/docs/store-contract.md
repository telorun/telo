# Queue store contract

This is the contract a queue backend implements. It is normative: a backend that
does not honour every rule here does not implement `Queue.Queue`, whatever its
kind extends.

A backend provides a kind that `extends: Queue.Queue` (or
`Queue.AddressableQueue`), declaring its own storage fields beside the inherited
`messageType`, `maxMessageBytes` and `retention`. Its controller's instance is
the **store**: the object the operation kinds receive through their `queue` slot.

## Division of work

A store stores. Everything else is the operation kinds', decided once for every
backend:

- every error code (`ERR_QUEUE_*`), every retry, backoff and dead-letter
  decision, the per-attempt timeout and the lease heartbeat;
- the byte bound, id minting, and encoding a message into its body;
- checking a body against `messageType` when it is delivered;
- the public list cursor (a store owns only the tail inside it).

A store answers every method with an **outcome**, never an error code — with
two exceptions, both terminal. A failure of the storage itself — a lost
connection, a full disk — is **thrown** as it arrives, uncoded, and the
operation raises it as the retryable `ERR_QUEUE_UNAVAILABLE` with the failure as
its cause. A failure re-issuing cannot fix is thrown as an `InvokeError`
carrying one of two codes, which the operation passes through unchanged:

- `ERR_QUEUE_GROUP_INVALID` — from `enqueue`, when the queue groups its messages
  and an item's group member is absent or not a string. Data `{ index }`, the
  item's position in the batch; nothing of the batch is stored.
- `ERR_QUEUE_STORE_INCONSISTENT` — from any method, when the store finds one of
  its own invariants broken (a row that should exist does not, an update that
  must match one row matches none). No data required.

A cancellation, and a coded error a backend's own operation kind raises before
calling the store (`ERR_ZONE_REQUIRED`), also pass through unchanged. A store
raises no other code: the operations declare only these.

## Recognition

A store is recognised by its methods alone — never by its class, and never by
having imported `@telorun/queue`, since a backend may live in another
repository. `isQueueStore` checks the eight base methods; `isAddressableQueueStore`
the twelve. The contract grows only additively.

Every method takes the calling invocation's context (`InvokeContext`) last, so a
remote call can be cancelled with it and a backend can find a zone the caller
opened (`ctx.zonesFor`). A local store may ignore it.

## Settings

```ts
settings(): { messageType: <JSON Schema>; maxMessageBytes: number }
```

What the queue was configured with, as the operations need it: the resolved
JSON Schema of `messageType`, and `maxMessageBytes` (262144 when omitted). A
backend computes it once in `create()` with `queueSettingsOf(resource, ctx)`
from `@telorun/queue`, which resolves the `messageType` slot — a named shape, a
reference, or a schema written in place — and fills the default, and answers it
from then on. A backend whose storage holds less may declare a lower maximum for
`maxMessageBytes` in its own kind's schema.

## Instants, durations and precision

**Every instant is the store's own clock.** The operations never send "now": a
store is handed **durations** (`lease`, a release's `visibleAfter`, an enqueue's
`after` when it is a duration) and computes "now plus this" itself, and an
enqueue's `after` when it is an instant (`Telo.Timestamp`) is stored as given. A
store renders both through its engine rather than formatting text: a SQL backend
writes `now + duration` with the engine Schema's `currentInstantPlus(duration)`,
an instant with `instantParameter(timestamp)`, and "now" with
`currentInstant()`, each a bound parameter, never statement text.

**Precision is the engine's, and rounding never delivers early.** A duration
arrives with nanosecond resolution (the worker computes waits to the
millisecond). Where the storage holds instants more coarsely, a visibility time
is rounded **up** to the next instant it can hold, so a message is never visible
before the time it was given; a lease's expiry may be rounded either way.
Instants a store returns (`enqueuedAt`, `visibleAt`, `settledAt`) are
`Telo.Timestamp` values at the engine's precision.

## The envelope

An enqueue hands the store an `EnqueueRequest`:

| Field | Meaning |
| --- | --- |
| `id` | The message's id: 1–128 printable ASCII characters, given or minted. |
| `body` | The message as **plain JSON text** — every Telo value in its plain encoding (an instant RFC 3339, a duration `5400s`, bytes base64url, an int64 or uint64 its exact digits), object keys sorted at every depth. Opaque to the store: kept byte for byte. A reader outside Telo reads and writes the same form. |
| `digest` | Lower-case hex SHA-256 of `body`. Two messages are "the same" exactly when their digests are equal. |
| `generation` | The envelope generation (`QUEUE_ENVELOPE_GENERATION`, 1). Stored and returned with the body. |
| `after` | Optional: a duration from the store's now, or an instant. Absent: visible now. |
| `traceparent`, `tracestate` | Optional W3C Trace Context of the enqueuing span. Stored and returned. |

A store keeps beside each message: the envelope, the enqueue instant, the
visibility time, the attempt count, the last error, the claim and its lease
expiry, its state and, once settled, the settle instant and a cancellation's
reason. There are no author headers.

## Methods

### `enqueue(items, ctx) → EnqueueOutcome[]`

One outcome per item, in order, from one round trip to the storage where it
allows. An item is `stored` once it is durable — it survives a crash or restart
of any process.

- A base store stores every item; two messages may share an id. It never
  answers `duplicate` or `conflict`.
- An addressable store answers `duplicate` when it already holds a message under
  the id whose digest is equal (nothing stored), and `conflict` when the digest
  differs. A message settled longer ago than `retention` reads as **absent**: the
  enqueue replaces it — on SQL, an insert whose conflict arm overwrites the row
  only when the existing one expired, a returned row meaning stored; with no row
  returned, one read of the stored digest settles duplicate versus conflict.
  Dead messages never expire.

### `claim({ limit, lease }, ctx) → { messages }`

Claims up to `limit` visible messages — pending, or running with a lease that
has lapsed — each under a lease expiring at now + `lease`, and answers them as
`ClaimedMessage`s (`id`, an opaque `claim` token, `body`, `generation`,
`attempt`, `enqueuedAt`, `lapsed`, `dying?`, `traceparent?`, `tracestate?`).
No visible message is an empty answer, never an error.

A store may wait inside `claim` for a message to become visible (a wake-up
channel), but never longer than a sixth of `lease`: the worker dates the lease
from the moment it calls `claim` and gives a message up when a third of it is
left, so a longer wait hands back what it claims.

- **Every claim is an attempt.** `attempt` is the count after this claim: 1 on
  the first.
- **`lapsed`** is true when the message's previous claim lapsed with the message
  unsettled. The worker counts that attempt as failed with
  `ERR_QUEUE_LEASE_EXPIRED`: when it used up the budget, the message is
  dead-lettered with that error and the handler is not run.
- **`dying`** carries the failure a previous claim's release recorded with
  `dying` (below): the worker goes straight to the dead-letter handler.
- **Competing consumers**: a claimed message is not claimed again until it is
  settled, released, or its lease lapses. Concurrent claimers skip each other's
  rows rather than wait (on SQL, the engine Schema's lock-skipping clause).
- **Group order**: a backend whose queue kind declares `groupBy` claims at most
  one message per group at a time — the oldest unsettled one by enqueue order —
  and a group whose oldest message is dead claims nothing until that message is
  requeued or cancelled. Different groups are claimed independently.
- **The purge hook**: an addressable store removes settled messages past
  `retention` (never dead ones) in bounded batches inside its claim transactions,
  skipping rows another transaction holds. Correctness never depends on it — an
  expired message already reads as absent — and nothing is purged while no worker
  claims. There is no separate maintenance method.

### `renew(claim, lease, ctx) → held | lost | cancelled`

Extends a held claim's lease to now + `lease`. The worker bounds each renewal
(its context is cancelled when a third of the lease is all that remains since
the last confirmed renewal) and gives the message up locally at that moment, so
a renewal answering after it changes nothing. `lost` when the claim is no
longer this one's (its lease lapsed and another claim took the message, or it
was settled). `cancelled` when `cancel` was requested for the running message:
the store settles it `cancelled` in the same step and the claim is over — the
worker stops the handler and settles nothing.

### `complete(claim, ctx) → settled | lost`

Settles a held claim as completed. A base store removes the message; an
addressable store keeps it (state `completed`) until `retention` has passed
after it settled. `lost` when the claim is no longer held — nothing changes.

### `release(claim, { visibleAfter, error, giveBack, dying? }, ctx) → settled | lost`

Hands a held claim back: the message becomes visible again at now +
`visibleAfter` (the backoff is stored here, as a visibility time) and `error`
becomes its last error (`null` keeps none). `giveBack: true` means the attempt
does not count — the worker was shutting down — so the attempt count returns to
what it was before this claim. `dying` marks the message as dead-pending: its
next claim carries it as `dying`. A later `complete` or `kill`, a requeue or a
cancel clears it.

### `kill(claim, error, ctx) → settled | lost`

Settles a held claim as dead, recording `error` as its last error. A dead
message is never claimed again and is kept, whatever `retention` says.

### `stats(ctx) → { pending, scheduled, running, dead, oldestPendingAge, exact }`

Counts per state — `scheduled` is not yet visible (delayed or backing off),
`running` is claimed under an unexpired lease — and how long the oldest pending
message has been visible (`null` when none is). `exact: false` when the counts
are an estimate (a backend may estimate a large table rather than scan it).

## The addressable level

An addressable store also implements four methods. An id names at most one
message from enqueue until `retention` has passed after it completed or was
cancelled; a settled message past retention is treated as absent everywhere.

### `get(id, ctx) → found { message } | absent`

`message` is a `StoredMessage`: `id`, `state` (`scheduled`, `pending`,
`running`, `completed`, `dead` or `cancelled`), `attempts`, `enqueuedAt`,
`visibleAt?`, `settledAt?`, `lastError?`, `reason?`, `body`, `generation`.

### `list({ state, limit, after? }, ctx) → page { messages, next? } | cursorInvalid`

Up to `limit` messages in `state`, oldest first by enqueue order, without
`body`. `next` is a **tail** — text this store alone reads — present only when
more exist. `after` is a tail this store returned: it is untrusted on every
call, it never becomes statement text or widens the read, and one the store
cannot read as its own is `cursorInvalid` before any read is made. The public
cursor wraps the tail in an envelope the operation owns and binds to the state.

### `cancel(id, reason, ctx) → cancelled | requested | unchanged { state } | absent`

A scheduled, pending or dead message is settled `cancelled` at once, recording
`reason`. A running one is marked cancel-requested — `requested` — and settled
`cancelled` at its next `renew`. A completed or cancelled message is
`unchanged`.

### `requeue(id, ctx) → requeued | unchanged { state } | absent`

A dead message becomes pending, visible now, its attempts reset to zero and its
dying mark cleared, keeping its enqueue order so it keeps its place in its group.
Any other state is `unchanged`.

## Guarantees a backend must give

- **Durability** — an enqueue that returned has stored the message, which
  survives a crash or restart of any process and is kept until settled. A
  storage that expires messages exposes that bound in its own kind's
  configuration.
- **Competing consumers** — one claimant per message under a time-bounded lease.
- **At-least-once delivery** — a store never loses a claimed message: an
  unsettled claim's lapse makes it claimable again.
- **Delayed visibility** — never claimed before its visibility time on the
  store's clock.
- **Attempts persisted** — every claim counts, including a lapsed one; a release
  with `giveBack` gives it back.
- **Dead is final until requeued** — never claimed again, kept.
- **Ordering** — none, except within a group of a backend declaring `groupBy`.
