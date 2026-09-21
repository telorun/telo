# Durable journal store

## Problem

`RecordStream.Journal` is the stdlib's replay buffer for detached streams. `JournalSink` drains a stream into it under a key. `JournalSource` replays a key from an offset, then tails it live until it finishes. That is what lets a client re-attach to work that outlives a connection.

The buffer is held in memory for the life of the process, so a restart loses every key. A client re-attaching after a restart finds nothing, and the work it was following is unrecoverable, even when the work itself was durable. Every detached stream in Telo has this problem. The authoring agent is the first consumer that cannot ship with it: its turns must survive a container restart.

There is no way to remove a key either. Nothing prunes old keys, and nothing distinguishes a key that was deleted from one that never existed. A reader asking for a deleted key cannot be told "gone"; it waits.

## Solution

### Kinds

*Before:* one concrete provider holds everything in memory.

*After:* the journal protocol and its storage are split, following the `KvStore.Store` precedent. A small abstract holds the storage operations, and the protocol is written once above it.

- **`RecordStream.JournalStore`** is a new abstract. It is a provider with storage operations only:
  - **append** a record under a key; the store assigns the next id atomically and refuses an append to a finished, failed or deleted key;
  - **read** a key from an offset;
  - **finish** a key, or **fail** it with a recorded error;
  - **delete** a key, keeping a marker so the key later reads as deleted rather than unknown;
  - **touch** an open key's writer heartbeat;
  - **list** keys by age and **prune** them;
  - an optional **wake signal**, so a backend can support tailing across processes.
- **`RecordStream.MemoryJournalStore`** is today's behaviour as an explicit concrete kind. It stays in this module because it depends on nothing.
- **`RecordStream.Journal`** keeps the protocol that would otherwise be rewritten in every backend:
  - waking in-process readers on append;
  - the retention policy;
  - the writer-liveness rule;
  - how finished, failed, deleted and unknown keys are reported.

  It gains a **required** `store:` slot (a dependency reference to `Self.JournalStore`). It also gains `retention:` (how old a finished key may get before a prune removes it) and `writerTimeout:` (see below), both creation-time.
- **`RecordStream.JournalDelete`** is a new invocable that deletes one key through a journal. Its outcome, `deleted` or `unknown`, is data.
- **`RecordStream.JournalPrune`** is a new invocable that removes every finished key older than the journal's `retention:` and returns the count. The application's scheduler triggers it. A provider performs no observable I/O in `init()` and has no `run()`, so the journal cannot own a timer.

*Why `store:` is required rather than defaulting to memory:* a default is a mode. It would leave the journal's controller with two code paths, and every later cross-cutting feature would have to be built twice or work only on one of them. It would also show the backend in a visual editor as an absence instead of a resource. Today's zero-config use becomes one inline line naming the memory store.

*Verify:*
- A journal with no `store:` fails `telo check` with a missing-required-property error at the resource.
- The same journal test suite passes unchanged against the memory store and the SQL store (below).

### What a reader is told

*Before:* a key that finished replays and ends. A failed key replays and raises. Any other key waits.

*After:* four states, each reported distinctly by `RecordStream.JournalSource`:
- **Live:** replay, then tail.
- **Finished:** replay and end.
- **Failed:** replay, then raise the recorded error.
- **Deleted:** raises **`ERR_JOURNAL_KEY_DELETED`**, a declared throw code. A route's `catches:` can map it (to 410, in the authoring agent), and the analyzer checks the mapping.

A key the store has never held keeps today's behaviour and waits. A reader legitimately connects before a detached writer has appended its first record, and refusing that would reintroduce the race this primitive exists to absorb.

*Verify:*
- Reading a deleted key raises the code.
- Reading a key that was never written, then writing it, delivers the records to the waiting reader.

### Writer liveness

*Before:* a writer cannot die without its process, and a process that dies takes the buffer with it, so an open key never outlives its writer.

*After:* with a durable store, a key can be left open by a writer that no longer exists. A reader would then tail it forever. So an open key carries its writer's heartbeat. `JournalSink` touches it on a period a third of the journal's `writerTimeout:` (default 30s) for as long as it drains, including through long gaps between records, such as a tool call that runs for minutes. A reader that finds an open key whose heartbeat is older than `writerTimeout` marks the key failed with **`ERR_JOURNAL_WRITER_LOST`** and raises it after replay. The heartbeat is separate from appends precisely because silence between records is normal.

*Verify:*
- Kill the process mid-drain and restart it. A reader replays up to the last record, then gets `ERR_JOURNAL_WRITER_LOST` within `writerTimeout`.
- A writer silent for a minute while a tool runs is not marked lost.

### Persistence of values

A record is a runtime value, and it may carry an int64 or bytes. A durable store persists records in the SDK's typed encoding, the one the durable journal already uses for this reason, so a replayed record has the same type it was appended with. A record stored as plain JSON would turn every int64 past 2^53 and every byte field into something else on replay.

*Verify:* a record carrying an int64 above 2^53 and a byte field replays with both unchanged in type and value.

### The SQL backend: new module `record-stream-sql`

*After:* a new module, `RecordStreamSql`. It imports `RecordStream` and `Sql`, and declares `RecordStreamSql.JournalStore`, which extends `RecordStream.JournalStore` and runs over any `Sql.Connection`, so SQLite and Postgres both work. Its fields are `connection`, `table` (default `record_stream_journal`; the key-state table is `<table>_keys`) and `createTable`, following `kv-store-sql`. Across processes it provides the wake signal by polling at `pollInterval` (default 250ms), used only by a reader outside the writer's process. In-process readers are woken by the journal itself. A backend with native notification can offer it through the same signal, and none goes on the neutral contract.

*Why a module of its own:* inside `record-stream`, every stream user would depend on `sql`. Inside `sql`, that module would collect a feature for every storage consumer. The dependency runs from the backend to both contracts and nowhere else.

*Verify:*
- `record-stream` declares no import of `sql`, and `sql` gains no reference to either module.
- The shared suite passes on SQLite in the root suite, with no infrastructure.
- The Postgres run lives under the new module's integration tests.

## Decisions

- **The store is journal-specific, not a general append-only log.** Finish and fail, delete markers, writer liveness and retention are stream-lifecycle rules. Event sourcing needs conditional append and durable execution needs claims, and a shared abstract would be too loosely specified to be useful to any of them. A later event store can live in its own module, and a backend module can implement both.
- **The durable-execution journal is not reused.** Its manifest declares it that backend's own seam and not everyone's. Its model is first-writer-wins keyed step results with no offsets, no stream states, no delete marker and no tail. Bending it would weaken the exactly-once contract that durable execution depends on.
- **Liveness is a heartbeat, not an append timeout.** A stream's silence carries no information about its writer.
- **An unknown key waits; only a deleted key refuses.**

## Correctness and edge cases

- **Two writers on one key.** Ids are assigned by the store atomically, and one writer per key is the protocol. A second sink on a live key is refused with `ERR_JOURNAL_KEY_BUSY` at its first append, rather than interleaving.
- **Append after delete.** Refused as closed, so a slow writer cannot resurrect a key a user deleted.
- **Prune racing a reader.** A prune removes only finished keys past retention. A reader mid-replay of one gets the records already read, then `ERR_JOURNAL_KEY_DELETED`. It never gets a partial replay presented as complete.
- **Clock skew across processes.** The heartbeat compares timestamps written by the store's own clock, not by each process, where the backend has one (SQL `now()`). The memory store is single-process.
- **Deleted markers forever.** Markers are pruned with their key's retention. After that, the key reads as unknown, which is correct for a key nobody remembers.

## Housekeeping

- **`record-stream`:**
  - A `telo release` fragment: `Changed`, a breaking change shipped as a minor per the pre-1.0 convention.
  - Its docs gain a normative store contract, like `kv-store`'s, covering the operations, atomicity, states, liveness and encoding.
  - The README, and hub descriptions that name no backend.
- **`record-stream-sql`:** an `Added` fragment, its docs and README, and hub descriptions that do not name the abstract's other implementations.
- **Existing users:**
  - The journal's own tests gain an inline memory store.
  - The authoring agent points its journal at a `RecordStreamSql.JournalStore` over its existing SQLite connection.
  - No manifest migration entry is needed: the only non-test user is an Application, which is never imported.
- **Floors:** `requires:` only where a module's own file uses grammar an older analyzer rejects, verified by running the previous published CLI against it. Both modules' controllers return effect chains, so both declare the effect-chain floor the stdlib already uses.
- **Authoring agent primer:** its `system:` block describes the required store, the two backends, delete, prune, writer liveness and the two new codes.
