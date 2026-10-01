# Watch

`watch` — wake-up signals for long polling. A request waits until a topic's
version moves past the cursor it last read; a writer raises the version after
committing a change and wakes every waiter below it. The store only signals —
the caller's database stays the source of truth, read before and after every
wait.

## Kinds

- **`Watch.Wait`** — invocable. Inputs `{ topic, after, timeout }`, output
  `{ changed, version }`. Returns at once when the topic's version is already
  greater than `after`, within milliseconds of a publish that lifts it there, and
  otherwise `{ changed: false, version }` at `min(timeout, maxTimeout)` —
  running out of time is data, never an error. A cancelled call releases its
  waiter and rethrows the cancellation. Config: `store` (required reference to a
  `Watch.Store`) and `maxTimeout` (required duration capping every call,
  evaluated once at creation, so it may come from a variable).
- **`Watch.Publish`** — invocable. Inputs `{ topic, version }`, no output.
  Raises the topic's version monotonically — a lower or equal version changes
  nothing — and wakes every waiter below it. Config: `store`.
- **`Watch.Store`** — abstract store: the latest version per topic and the
  waiters on it. Contract: [docs/store-contract.md](docs/store-contract.md).
- **`Watch.MemoryStore`** — the store in this process's memory. Nothing is shared
  between instances or survives a restart. `maxTopics` (default `100000`) bounds
  how many topics nobody waits on are remembered; beyond it the least recently
  raised of them are forgotten. A topic with waiters is never forgotten.

## Example

```yaml
kind: Telo.Application
metadata: { name: Plans, version: 1.0.0 }
imports:
  Watch: oci://ghcr.io/telorun/watch@0.2.0
---
kind: Watch.MemoryStore
metadata: { name: watchStore }
---
kind: Watch.Wait
metadata: { name: planChanged }
store: !ref watchStore
maxTimeout: 30s
# invoked with { topic: "plan:42", after: 7, timeout: 25s }
# → { changed: true, version: 8 } when version 8 is published while it waits
# → { changed: false, version: 7 } after 25s otherwise
---
kind: Watch.Publish
metadata: { name: planSaved }
store: !ref watchStore
# invoked with { topic: "plan:42", version: 8 } after the write commits
```

The full request shape — read, wait on the version just read, read again — and
why it misses no change is in [docs/long-polling.md](docs/long-polling.md).

## Durable runs

A wait lives only in the call that opened it, so `Watch.Wait` declares that it
cannot run inside a replayed (durable) region: `telo check` reports
`ZONE_ATTRIBUTE_VIOLATED` there, and the runtime refuses with
`ERR_WATCH_REPLAY_FORBIDDEN`. A durable run waits with `Durable.Await`.

## One value to one waiter

`watch` is a version signal any number of waiters share, carrying no payload.
Handing one value to exactly one waiter is a different primitive — see
[docs/long-polling.md](docs/long-polling.md#a-version-signal-not-a-hand-off).
