# Record Stream

Stream operations on structured records. Format-neutral transformers, sources, and sinks that operate on `Stream<record>` — distinct from byte-stream codecs (`Octet`, `Ndjson`, `Sse`, `PlainText`) which all produce `Stream<Uint8Array>`.

## Why use this

- **Tagged-union projection** — `ExtractText` projects a discriminated stream down to `Stream<string>` via a per-variant `emit` / `drop` / `throw` action map.
- **Loud on unknown variants** — unmapped discriminator values throw `ERR_UNKNOWN_RECORD`; new record kinds never silently disappear.
- **Lazy fan-out** — `Tee` serializes source pulls and buffers per-consumer, so each branch sees every item in order.
- **Stream-typed** — every input and output is `x-telo-stream: true`, so chains compose with codecs, sinks, and other stream kinds.

## Kinds

| Kind | Purpose |
| --- | --- |
| `RecordStream.ExtractText` | Project a discriminated `Stream<record>` to `Stream<string>` via a per-variant action map. |
| `RecordStream.Tee` | Fan one input stream out to two consumers; each output sees every item. |
| `RecordStream.OnComplete` | Forward a stream while firing a handler once, at end-of-stream, with every item observed. |
| `RecordStream.JournalStore` | Abstract: the storage a journal runs over (see [the store contract](docs/store-contract.md)). |
| `RecordStream.MemoryJournalStore` | A journal store in the process's memory. |
| `RecordStream.Journal` | A keyed, offset-addressable replay journal over a store (Provider). |
| `RecordStream.JournalSink` | Claim a key and drain a stream into it, with a writer heartbeat. |
| `RecordStream.JournalSource` | Read a key from any id: replay, then tail live until it ends. |
| `RecordStream.JournalRemoval` | Remove one key; readers are told it was removed. |
| `RecordStream.JournalExpiry` | Apply the journal's retention; run it on a schedule. |

## Example

```yaml
kind: RecordStream.ExtractText
metadata:
  name: Deltas
discriminator: type
records:
  text-delta: { do: emit, field: delta }
  finish:     { do: drop }
  error:      { do: throw, field: error }
```

## RecordStream.ExtractText

Projects a discriminated stream of records down to a `Stream<string>` using a per-variant action map.

Each item flowing through `input` is matched on `record[discriminator]` against the `records` map. The matched entry's `do` action selects behaviour:

| Action  | Behaviour                                                                                                        |
| ------- | ---------------------------------------------------------------------------------------------------------------- |
| `emit`  | Yields `record[field]` (which must be a string) downstream.                                                      |
| `drop`  | Silently skips the record.                                                                                       |
| `throw` | Raises an error using `record[field]?.message ?? String(record[field])`. Aborts the iteration.                   |

Records whose discriminator value isn't listed throw `ERR_UNKNOWN_RECORD` — loud failure beats silent loss. When a known but intentionally-skipped variant is observed, configure it with `do: drop`.

### Example: AI streaming chat

The canonical use case is projecting `Ai.TextStream`'s `Stream<StreamPart>` (where parts are `text-delta` / `finish` / `error`) down to a `Stream<string>` of plain text deltas — typically piped into a text-aware sink like `Console.WriteStream` or an HTTP response body.

The pipeline becomes `Ai.TextStream -> RecordStream.ExtractText -> Console.WriteStream` — no codec, no byte-encoding intermediate.

### Forward-compatibility

When the upstream record union widens (e.g. AI providers add `tool-call-delta`, `thinking`, citation parts), existing consumers either add a new `records` entry or get the `ERR_UNKNOWN_RECORD` failure. There's no silent loss of new record kinds.

## RecordStream.Tee

Fan one input stream out to two consumers. Each output sees every item from the source.

```yaml
kind: RecordStream.Tee
metadata: { name: TeeStream }
```

```yaml
- name: Tee
  invoke: !ref TeeStream
  inputs:
    input: !cel "steps.SomeProducer.result.output"
- name: Branch1
  inputs:
    input: !cel "steps.Tee.result.outputA"
  invoke: { kind: ... }
- name: Branch2
  inputs:
    input: !cel "steps.Tee.result.outputB"
  invoke: { kind: ... }
```

### Buffering semantics

Source is pulled lazily — at most one source `next()` is in flight at any time, even under concurrent consumers (an internal lock serializes pulls). When one output iterates ahead of the other, items accumulate in memory for the lagging consumer. Buffer is bounded by the source stream's length, which is fine for finite streams (chat replies, HTTP responses, file reads). For unbounded streams with potentially divergent consumer speeds, a future bounded-buffer / lockstep variant should be used instead.

### Errors

If the source iterator throws, both outputs throw the same error on their next pull.

## RecordStream.OnComplete

A passthrough that fires a side effect once the input has been fully consumed. Every item forwards to `output` in order as it arrives — the downstream consumer streams live — and when the input completes normally the injected `handler` is called **once** with `{ records, context }`: `records` is the full list of items observed, `context` is the opaque caller data passed through the `context` input.

This closes the persist-while-streaming loop: an HTTP handler streams an AI/agent response to the client via `output`, and at end-of-stream `handler` writes the turn to a store. It's the answer to "I need to tee one branch to a SQL sink" — the second branch of a `Tee` has no autonomous driver inside a stream handler, whereas `OnComplete` is driven by the response being consumed.

The kind is domain-neutral — it does no CEL and knows nothing of SQL. The projection from `records` to whatever the store needs lives in `handler`, typically a `Run.Sequence`:

```yaml
kind: RecordStream.OnComplete
metadata: { name: Persist }
handler: !ref PersistTurn        # a Run.Sequence taking { records, context }
---
kind: Run.Sequence
metadata: { name: PersistTurn }
inputs: { records: {}, context: {} }
steps:
  - name: Insert
    inputs:
      sql: "INSERT INTO turns (conversation_id, content) VALUES (?, ?)"
      bindings:
        - !cel "inputs.context.conversationId"
        - !cel "inputs.records.filter(r, r.type == 'text-delta').map(r, r.delta).join('')"
    invoke: { kind: Sql.Command, connection: !ref Db }
```

Wired into an HTTP stream route, `handler` runs after the last frame flushes to the client:

```yaml
- name: Ask
  invoke: !ref Assistant           # Ai.AgentStream → { output: stream }
  inputs: { messages: !cel "steps.History.result.rows" }
- name: Persist
  invoke: !ref Persist
  inputs:
    input: !cel "steps.Ask.result.output"
    context: { conversationId: !cel "inputs.conversationId" }
# return { output: steps.Persist.result.output } to the response
```

### Semantics

- `handler` is called **once**, after `input` runs to its end. Not called if the input throws (the error propagates) or the consumer cancels early (`break` / aborted response) — completion means the input reached its end.
- Records are buffered in memory, bounded by the input stream's length (same envelope as `Tee`).
- A `handler` error is not swallowed: it propagates as the output stream terminates.

## RecordStream.Journal — resumable, offset-addressable replay

`OnComplete` and `Tee` observe a stream as it is consumed **once**; neither
survives the consumer disconnecting. `Journal` decouples producing a stream from
consuming it, so a **detached** stream becomes **resumable**: a producer streams
records into a keyed journal, and any number of consumers read them back from any
offset — replaying what they missed, then tailing live until the key ends. On a
durable store the records outlive the process, so a reader resumes after a
restart too.

This is the backbone of a resumable transport (e.g. an SSE endpoint that
survives a page refresh): start the work detached into the journal under a
`turnId`, hand the client that id, and let it read `JournalSource` with its last
seen `id` as `fromId` (an SSE `Last-Event-ID`). It reconnects to exactly where it
dropped off.

### The store

A journal names where its records live with a **required** `store:`:

- **`RecordStream.MemoryJournalStore`** — in the process's memory. Declare it
  inline for one process: development, tests, anything that need not survive a
  restart.
- **A durable store** — any kind extending `RecordStream.JournalStore`, for
  records that survive restarts and are shared between processes.

The journal protocol is written once, above the store; a backend implements eight
storage primitives and nothing else. See [the store contract](docs/store-contract.md).

```yaml
kind: RecordStream.Journal
metadata: { name: turns }
store: { kind: RecordStream.MemoryJournalStore }
retention: 24h          # how long an ended key is kept
writerTimeout: 30s      # optional; 30s when omitted
---
kind: RecordStream.JournalSink
metadata: { name: sink }
journal: !ref turns
---
kind: RecordStream.JournalSource
metadata: { name: source }
journal: !ref turns
# POST route: invoke sink { key: turnId, input: <agent stream> } detached, return turnId.
# GET  route: invoke source { key: turnId, fromId: <Last-Event-ID> } → SSE-encode { id, data }.
```

Records are written as typed values, so an int64 past 2^53 or a bytes field
replays with its type and value on every store.

### Writing — `RecordStream.JournalSink`

`{ key, input }` → `{ key, count }`. The sink **claims** the key before it pulls
the first record, then appends each record with the next id (1-based,
gap-free). On normal completion the key is **finished**; on an input error it is
**failed** — the error's code, message and data are recorded for readers — and
the error is rethrown. Invoke it **detached** (`Run.Detach`) to return the key to
a client immediately while the stream fills the journal.

While it drains, the sink sends a **heartbeat** every third of the journal's
`writerTimeout`, whether records arrive or not — a tool call that runs for
minutes is silence, not death. A writer whose heartbeat is older than its
timeout (its process died, or stalled) has its key failed as abandoned.

The sink raises:

| Code | When |
| --- | --- |
| `ERR_JOURNAL_KEY_BUSY` | The key already exists and belongs to another writer — live, finished or failed. Raised at the claim, before any record is pulled, or later if another writer took the key. |
| `ERR_JOURNAL_KEY_REMOVED` | The key was removed, before the claim or while the drain ran. |
| `ERR_JOURNAL_WRITER_LOST` | This writer's key was failed as abandoned; its next write is refused. |

On any of these the sink stops the drain and cancels its input.

The sink also re-raises its input stream's own error unchanged — whatever the
producer raised. That error is not in the kind's `throws:`, since no literal list
can name it: a `catches:` entry naming its code is `UNDECLARED_THROW_CODE` at
`telo check`, and a trace records the failed drain as `InvokeRejected.Undeclared`.

### Reading — `RecordStream.JournalSource`

`{ key, fromId? }` → `{ output }` of `{ id, data }` entries with `id` greater than
`fromId` (0 replays from the start). What follows the replay is the key's state:

| State | The reader |
| --- | --- |
| Live | tails it until it ends |
| Finished | ends |
| Failed | raises the recorded error, with its original code |
| Writer abandoned | raises `ERR_JOURNAL_WRITER_LOST` — within the writer's timeout of its last heartbeat |
| Removed | raises `ERR_JOURNAL_KEY_REMOVED` — from the invoke itself when the key is already removed, so a route's `catches:` can map it (e.g. to 410) |
| Never written | waits, then delivers once a writer claims it |

A reader that saw a key and then finds it gone — expired between two pages —
raises `ERR_JOURNAL_KEY_REMOVED` rather than ending as if the key had finished.

Only a removal at open is raised by the **call**, so it is the only code in the
kind's `throws:` — the one a `catches:` for the read can map. Everything after
that is raised by the returned **stream**: a removal mid-read, a lost writer, a
failed key's recorded error, and `ERR_INVOKE_CANCELLED`. The stream ends as soon
as its consumer stops — even while it is waiting for the next record — and
raises `ERR_INVOKE_CANCELLED` when the invocation that opened it is cancelled (a
step's `timeout:` elapsing, a cancelled run). Either way it makes no further
store call.

### Removal and expiry

- **`RecordStream.JournalRemoval`** — `{ key }` → `{ outcome }`: `removed` (also
  when the key already was) or `unknown`. The records are deleted and a marker
  kept, so readers are told the key was removed rather than left waiting; a
  writer still draining it is refused.
- **`RecordStream.JournalExpiry`** — no inputs → `{ count }`. Removes the records
  of every finished or failed key older than the journal's `retention:`, forgets
  markers older than it, fails keys whose writer stopped heartbeating, and returns
  how many keys it removed. A journal owns no timer, so trigger it from a
  schedule:

```yaml
kind: Scheduler.Interval
metadata: { name: expireTurns }
every: 1h
invoke: { kind: RecordStream.JournalExpiry, journal: !ref turns }
```
