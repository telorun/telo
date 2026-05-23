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
  invoke: { kind: RecordStream.Tee, name: TeeStream }
  inputs:
    input: "${{ steps.SomeProducer.result.output }}"
- name: Branch1
  inputs:
    input: "${{ steps.Tee.result.outputA }}"
  invoke: { kind: ... }
- name: Branch2
  inputs:
    input: "${{ steps.Tee.result.outputB }}"
  invoke: { kind: ... }
```

### Buffering semantics

Source is pulled lazily — at most one source `next()` is in flight at any time, even under concurrent consumers (an internal lock serializes pulls). When one output iterates ahead of the other, items accumulate in memory for the lagging consumer. Buffer is bounded by the source stream's length, which is fine for finite streams (chat replies, HTTP responses, file reads). For unbounded streams with potentially divergent consumer speeds, a future bounded-buffer / lockstep variant should be used instead.

### Errors

If the source iterator throws, both outputs throw the same error on their next pull.
