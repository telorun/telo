# The Rendezvous.Point contract

Normative. A point is an instance a `Rendezvous.Await` or `Rendezvous.Deliver`
references through its `point:` slot. It is recognised by its two methods alone,
never by its class and never by having imported this module's code, so a backend
may live in another module or repository. The interface ships under the code
specifier `@telorun/rendezvous` for a backend that wants the types; importing it
is optional.

## Operations

- **`take(key, timeoutMs, ctx)`** resolves one of:
  - `taken` with the delivered `payload`;
  - `timedOut` when `timeoutMs` passed first;
  - `cancelled` when the invocation `ctx` was cancelled first, or the point was shut down;
  - `busy` when another take already waits under `key`.
- **`offer(key, payload, ctx)`** resolves `delivered` when a waiting take received
  the value, or `held` when none was waiting and the value was kept.

A `timeoutMs` of 0 takes a held value or resolves `timedOut` at once, without waiting.
Teardown of the point resolves every pending take as `cancelled`.

Neither operation rejects on any of those outcomes. `Rendezvous.Await` and
`Rendezvous.Deliver` own every code: `busy` becomes `ERR_RENDEZVOUS_KEY_BUSY`,
`timedOut` becomes `ERR_RENDEZVOUS_AWAIT_TIMEOUT`, `cancelled` rethrows the
cancellation, `held` becomes `delivered: false`. A point rejects only when it
cannot do its work at all.

## Atomicity per key

For one key, take and offer are atomic against each other:

- A value goes to at most one take.
- A take that resolved `timedOut` or `cancelled` consumed nothing: a value offered
  afterwards is held, never lost to it.
- A take and an offer racing are decided by the point: a value arriving after a
  take's timeout is held for a later take and never reaches a take that already
  resolved.
- A key holds a waiter or a held value, never both.

## Release without consuming

A take that leaves — by timeout, by cancellation, or because the point is shut
down — removes its waiter and nothing else. Cancellation reaches `take` through
the invocation context; a point observes it and resolves `cancelled` at once,
without waiting for its own deadline.

## Held values

- A value offered while no take waits is held for the point's `hold`, which a
  backend reads from its own configuration (`hold` defaults to `60s` when omitted). A take opening inside the window
  receives it immediately and removes it.
- An offer to a key already holding a value **replaces** it and restarts the
  window; it still resolves `held`.
- A held value past its window is removed unobserved. A later take waits fresh.
- An offer after a hand-over finds no memory of the key and is held like a first
  offer. A point keeps no marker of a completed meeting.
- Held values are bounded by the delivery rate times `hold`. The memory backend
  has no cap of its own, so a producer delivering to keys nobody waits on grows it
  until the window expires them.

## One waiter per key

A second take under a key that already has a waiting one resolves `busy` and
leaves the first untouched. A client that reconnects before the server saw the old
connection close therefore retries.

## Reach

The memory backend is one process: a take and an offer in different instances
never meet, and the offer resolves `held`. A backend that spans processes wakes a
take held in one instance when another offers; the contract is the same.
`delivered` means a take received the value; if that take's caller is cancelled in
the same instant, the value goes with it.
