# Operations

Every operation names its queue through one configuration field, `queue`. The
four addressable operations take an addressable queue only — naming a plain
queue is refused by `telo check` (`REFERENCE_KIND_MISMATCH`). Each raises:

- `ERR_QUEUE_UNAVAILABLE` (retryable) when the queue's storage cannot be reached
  or fails, with the storage's own failure as the cause;
- `ERR_QUEUE_STORE_INCONSISTENT` (terminal) when the storage answers in a way its
  contract rules out — a broken invariant the storage reports, or an answer that
  is no outcome. Re-issuing the call cannot help; the storage needs attention.

## Queue.Enqueue

Adds one message. Input: a `Queue.EnqueueItem` —

| Input | Meaning |
| --- | --- |
| `message` | Required. The message, checked against the queue's `messageType`: a literal by `telo check`, a computed one by the input contract (`ERR_INPUT_INVALID`). |
| `id` | Optional: 1–128 printable ASCII characters, no space. Omitted, a fresh id is minted (`msg_` and 22 base-62 characters, 128 random bits). |
| `after` | Optional: a duration of at least zero from now on the queue's own clock (`30s`, or integer milliseconds), or an instant (RFC 3339). Omitted, the message is deliverable at once. |

Output: `{ id, enqueued }`. `enqueued` is false only on an addressable queue
already holding the same message under the id — nothing is stored, so a retried
enqueue is safe. `id` is exported on the dispatch span as `telo.queue.message.id`.

Codes:

- `ERR_QUEUE_MESSAGE_TOO_LARGE` — the encoded message is over the queue's
  `maxMessageBytes`; data `{ bytes, maxBytes }`. Nothing is stored.
- `ERR_QUEUE_ID_CONFLICT` — an addressable queue holds a different message under
  the id; data `{ id }`. "The same message" means the same canonical body.
- `ERR_QUEUE_GROUP_INVALID` — the queue groups its messages (`groupBy`) and the
  message's group member is absent or not a string. Terminal; nothing is stored.
- `ERR_QUEUE_UNAVAILABLE` here means the message may or may not be stored:
  retrying is safe on an addressable queue when the call names an id, and may
  store a second message when it does not.
- `ERR_ZONE_REQUIRED` — the queue's storage stores a message only inside an
  enclosing zone (a transaction) and the call is outside it.

Whether an enqueue joins a transaction the caller has open is the storage's own
rule; this module promises no atomicity with anything else.

## Queue.EnqueueMany

Adds 1–1000 messages in one call to the storage. Input `messages`, a list of
`EnqueueItem`; output `messages`, one `{ id, enqueued }` per input, in order.
The batch is not atomic. A too-large message is refused before anything is
stored, with data `{ index, bytes, maxBytes }`, as is a group refusal
(`ERR_QUEUE_GROUP_INVALID`, data `{ index }`); a conflict names the first item
that has one, `{ index, id }`, and the other items may have been stored —
retrying the batch with the same ids stores nothing twice on an addressable
queue.

## Queue.Stats

Input `{}`; output `{ pending, scheduled, running, dead, oldestPendingAge, exact }`:
messages deliverable now, not yet visible, claimed, and dead; how long the oldest
pending message has been deliverable (null when none is); and whether the counts
are exact or the storage's estimate.

## Queue.Status

Input `{ id }`. Output `{ id, state, attempts }` plus, for a message the queue
holds, `enqueuedAt`, `visibleAt`, `settledAt`, `lastError { code, message }`,
`reason` (a cancellation's) and `message` — the message, or null when the stored
body no longer has the queue's `messageType`. `state` is one of `scheduled`,
`pending`, `running`, `completed`, `dead`, `cancelled`, or `unknown` for an id
no message holds (or one settled longer ago than `retention`) — an ordinary
answer, not an error.

## Queue.List

Input `state` (one of the six real states), `limit` (1–1000, default 100) and
`cursor`. Output `messages`, oldest first, each
`{ id, state, attempts, enqueuedAt, visibleAt?, settledAt?, lastError? }`, and
`next` — the cursor of the next page, absent on the last. A cursor is opaque and
bound to the state it lists; one from another listing, or one the queue can no
longer read, is `ERR_QUEUE_CURSOR_INVALID`.

## Queue.Cancel

Input `{ id, reason? }`; output `{ id, cancelled, state }`. A scheduled, pending
or dead message is cancelled at once (`cancelled: true`, `state: cancelled`). A
running one is cancelled at its handler's next lease renewal, which cancels the
handler (`cancelled: true`, `state: running`). A completed, cancelled or unknown
message answers `cancelled: false` with its state.

## Queue.Requeue

Input `{ id }`; output `{ id, requeued, state }`. A dead message becomes pending
with its attempts reset and its place in its group kept (`requeued: true`,
`state: pending`); anything else answers `requeued: false` with its state.
