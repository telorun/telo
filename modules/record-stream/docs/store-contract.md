---
description: "The RecordStream.JournalStore contract: eight primitives over a versioned header and an ordered log, the guarantees a backend owes, and the journal protocol written once above them."
sidebar_label: Journal store contract
---

# `RecordStream.JournalStore` contract

This is the normative definition of the abstract. A backend that cannot meet the guarantees below — above all, that each conditional write is one atomic step — must not implement it.

## What it is, and what it is not

A store holds, per key, a **header** and an **ordered log**. It is storage only: the journal protocol — claims, heartbeats, finished and failed keys, removal markers, expiry, the stale-writer rule and every state a reader is told — lives once in `RecordStream.Journal` and ships to every backend through `@telorun/record-stream`. No backend source names a journal state; a backend that did would be a second place for the ownership rule to be wrong.

A key's ownership and its log change together, in one write, in one store. That is why this is not a `KvStore.Store` plus a separate log: split across two stores, "only the owner appends", "nothing appends after removal", "a finished key has all its records" and "expiry does not race a reader" each become a cross-store race — and a TTL lapse would free a dead writer's key for someone else instead of reporting it lost.

## The data

- **Header** — per key:
  - `value`: an opaque string the journal owns (a typed frame). Never parse it.
  - `version`: an opaque, store-generated token naming one revision of the KEY — header and log together. It advances on every write to the key, appends included. Never parse it, never order by it.
  - `ageMs`: milliseconds since the header was last written, measured on the **store's** clock.
- **Log** — per key, records with ids `1, 2, 3, …`: 1-based and gap-free. A record is an opaque string (a typed frame).

There is no TTL and no eviction. A key exists until it is deleted.

## Operations

```
read(key, fromId, limit)                → { header | null, entries: [{ id, record }] }
putIfAbsent(key, value)                 → version | null
compareAndSet(key, version, value)      → version | null
compareAndAppend(key, version, record)  → { id, version } | null
compareAndTruncate(key, version, value) → version | null
compareAndDelete(key, version)          → boolean
scan(minAgeMs, cursor, limit)           → { headers: [{ key, value, version, ageMs }], cursor | null }
wait(key, version | null, timeoutMs, cancellation) → void
```

### `read`

The header and the entries with `id > fromId`, at most `limit` of them, as **one snapshot**: the entries are exactly the log at the moment the header was read. Every page carries the header, which is how a reader mid-replay learns that a key was removed or expired under it. `limit: 0` reads the header alone. An absent key reads as `{ header: null, entries: [] }`.

### `putIfAbsent`

Creates the key with this header and an empty log, stamping the store clock. Returns the version, or `null` when the key exists. One operation at the backend — a unique-key insert — never a read followed by a write.

### `compareAndSet`

Replaces the header if the key is still at `version`, and **stamps the store clock**, so its age restarts. Returns the new version, or `null`. Rewriting the same value is how a writer's heartbeat works.

### `compareAndAppend`

If the key is still at `version`: assigns the next id, stores the entry and advances the version — **one atomic step**, so two appends can never take the same id and an append can never land after a write it did not see. It does not restart the header's age. Returns the id and the new version, or `null`.

### `compareAndTruncate`

If the key is still at `version`: drops every entry and writes the header, in one step, stamping the store clock. Returns the new version, or `null`. While the key exists, no later append reuses an id a reader has seen, because the journal never appends to a key it has truncated. Once expiry deletes the marker the key is unknown again, and a writer claiming it anew starts at id 1.

### `compareAndDelete`

If the key is still at `version`: drops the header and every entry. Returns whether it did.

### `scan`

Headers whose `ageMs` is at least `minAgeMs`, **oldest first**, at most `limit` per call, with an opaque `cursor` to continue from (`null` when there is nothing more). A header written during a scan becomes young and need not be returned again.

### `wait`

Resolves once the key's version differs from `version` (`null` meaning "absent" — so waiting on an absent key resolves when it is created), after `timeoutMs`, or once `cancellation` (a required SDK `CancellationToken`) is cancelled — whichever comes first. **Required and bounded**: it never waits past `timeoutMs`, and neither reaching it nor being cancelled is an error — `wait` never rejects on either. A backend with no notification polls inside the bound; one with notification returns as soon as it hears of a change. Returning early is always allowed — the caller re-reads.

Once cancelled, a wait releases everything it holds — its timer, its waiter entry, its poll loop — and issues no further statement; a statement already in flight finishes and its result is discarded. A backend removes a key's waiter entry when the last waiter on that key leaves, so waiting leaves nothing behind. The journal cancels a reader's wait the moment its consumer stops or the reading invocation is cancelled.

## Guarantees a backend owes

1. **Every conditional write is atomic** across every process sharing the backend, and presents the version: a write at a version that is no longer current changes nothing.
2. **Losing a race is an outcome, not an error.** A refused conditional write returns `null` (or `false`). A backend never throws to report contention.
3. **Failure surfaces.** A backend that cannot complete an operation throws. It never reports a write it did not make.
4. **One clock.** `ageMs` is measured against timestamps the store itself wrote, on one clock — the database's, where there is one — never each process's. A reader in one process judges a writer in another by it.
5. **Opaque values.** Header values and records are stored and returned byte for byte. The journal writes them as SDK typed frames, so an int64 past 2^53 and a bytes field come back with their type and value on every backend — only if the backend does not reinterpret them.
6. **No eviction.** A key, its header and its log survive until `compareAndTruncate` or `compareAndDelete` removes them.

## The protocol above it

For a backend author, what the journal does with these primitives:

| Step | Primitive |
| --- | --- |
| A writer claims a key, recording its holder token and its timeout | `putIfAbsent` |
| Heartbeat, every third of the writer's timeout | `compareAndSet` of the same value |
| Append a record | `compareAndAppend` |
| Finish, or fail with the error's code, message and data | `compareAndSet` to a terminal header |
| Fail a key whose writer's heartbeat is older than **the timeout the writer recorded** | `compareAndSet` at the version that was read — a live writer's heartbeat or append changes the version, so a live writer is never failed |
| Remove a key, leaving a marker | `compareAndTruncate`, retried on contention |
| Expiry: fail dead writers, turn ended keys past retention into markers, delete markers past retention | `scan`, then the writes above and `compareAndDelete` |
| A reader tails a live key | `read`, then `wait` for up to the time left before the writer could go stale |

A refused append or heartbeat is explained by re-reading the header: a marker (or no key) is `ERR_JOURNAL_KEY_REMOVED`, the writer's own key failed as abandoned is `ERR_JOURNAL_WRITER_LOST`, any other holder is `ERR_JOURNAL_KEY_BUSY`.

## Implementing one

A backend is a `Telo.Definition` with `extends: RecordStream.JournalStore` whose controller's instance satisfies the `JournalStore` interface exported by `@telorun/record-stream` (declare the module in your library's `imports:` so the specifier resolves to its code). Prove it with the shared behaviour suite: the library at `modules/record-stream/tests/__fixtures__/journal-suite` takes the store as a `resources:` input and exports one sequence per behaviour; run them all, `expiry` first, against a store that starts empty.
