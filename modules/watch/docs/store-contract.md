# Store contract

`Watch.Store` is the abstract every backend implements. `Watch.Wait` and
`Watch.Publish` reach it through their `store:` reference and call the two
methods below on the instance; a backend that implements them can be dropped in
under either kind with no other change. This page is normative.

A store is a **wake-up signal**, never a source of truth: the caller reads its
own database before and after waiting. Everything below follows from that — a
store may forget, and may wake a waiter early, and neither is a failure.

## Versions

A version is a signed 64-bit integer, passed and returned as a `bigint`. Per
topic, the store remembers the highest version it has been given. A topic the
store has never heard of — or has forgotten — reads as `0`.

## `raise(topic, version) → Promise<void>`

- When `version` is greater than the remembered version, it becomes the
  remembered version, and **every** waiter on the topic whose `after` is below it
  is woken with `{ changed: true, version }`.
- When `version` is lower than or equal to the remembered version, nothing
  changes and nobody is woken.
- Resolves with no value once the raise is applied. Nothing reads a result.
- Must be atomic with respect to `wait`: a wait opened after a raise has
  resolved sees that raise's version (unless the topic has since been
  forgotten — see below).

## `wait(topic, after, timeoutMs, cancellation) → Promise<{ changed, version }>`

Resolves exactly once, with whichever comes first:

| Event | Result |
| --- | --- |
| The remembered version is greater than `after` when the wait opens | `{ changed: true, version }` at once |
| A raise lifts it above `after` while waiting | `{ changed: true, version }` |
| `timeoutMs` elapses (zero or less: at once) | `{ changed: false, version }` |
| `cancellation` is cancelled (already cancelled: at once) | `{ changed: false, version }` |

- `version` is the remembered version at the moment the wait resolves.
- It **never rejects** on the timeout or the cancellation; `Watch.Wait` decides
  what a cancellation means. A backend failure (a lost connection) rejects.
- On every path the waiter is **released**: its timer, its cancellation
  subscription and its registration in the store are gone once it has resolved.
- Any number of waits may be open on one topic, each with its own `after`.
- A backend may resolve a wait with `changed: false` before its deadline — at
  teardown, or when a listener it depends on is lost. The caller re-reads its
  source of truth, so an early return costs one round trip and is never wrong.

## Forgetting

A backend may forget a topic nobody is waiting on. A forgotten topic reads as
version `0`, so the only effect is that a later wait whose cursor was already
passed waits instead of returning at once — until its timeout, or until the next
raise. A backend must not forget a topic while a waiter is registered on it.

`Watch.MemoryStore` keeps topics nobody waits on in least-recently-raised order
and forgets from the oldest end once there are more than `maxTopics` of them. A
topic with waiters is outside that order — it is neither counted nor scanned —
and re-enters at the most recent end when its last waiter leaves, so memory is at
most `maxTopics` plus the topics currently waited on.

## Across processes

`Watch.MemoryStore` is one process: a raise wakes only the waiters held by the
same process. A backend shared by several instances of an application must wake
a waiter in any instance on a raise in any other, and must keep the ordering
rule above across them — a wait that opens after a raise has been acknowledged
anywhere sees it. It declares its own configuration (a connection, a channel)
and extends `Watch.Store`; `Watch.Wait` and `Watch.Publish` need no change.
