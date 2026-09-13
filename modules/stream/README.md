# Stream

Generic stream substrate — value-agnostic stream construction. `Stream.Of`
emits a declared list of literal items as a stream, in order. It's the telo-
native way to seed a pipeline with fixed data (instead of a `JS.Script`).

## Why use this

- **Declarative source** — produce a stream from literal values in the manifest;
  no inline JavaScript.
- **Value-agnostic** — items may be strings, objects, or numbers; the consumer
  decides what the elements mean (strings into `PlainText.Encoder`, AI-shape
  records into `RecordStream.ExtractText`, …).

## Kinds

| Kind | Purpose |
| --- | --- |
| `Stream.Of` | Emit a declared list of literal `items` as a `Stream`, in order. |
| `Stream.Collect` | Consume a `Stream` to completion and return its `items` as an array — the inverse of `Stream.Of`. Draining drives the producer's side effects (e.g. runs an `Ai.AgentStream` turn) and materializes the finite stream for inspection or assertion in CEL. Buffered — bounded by the stream's length. |
| `Stream.Chunk` | Re-frame a byte stream into consecutive fixed-size pieces, each carrying its own offset, index and whether it is the last. |
| `Stream.Map` | Transform every value with a CEL expression — one in, one out. |
| `Stream.Scan` | Accumulate, emitting the running state after every value. A fold that emits as it goes. |
| `Stream.FlatMap` | Expand every value into any number of values, flattened. Emit `[]` to drop one. |
| `Stream.Tap` | Hand every value to a handler just before delivering it, unchanged and in order — gated by `when:`, holding nothing. Printing a command's output live while a later stage still reads it. |

The three transforms — `Map`, `Scan`, `FlatMap` — are what make a streaming
protocol expressible in a manifest: an SSE decoder hands over wire frames, and
turning those into a provider's records is mapping, accumulating and re-fanning
them. `Tap` observes rather than transforms: its output is its input.

All four are **lazy** — the work happens as the consumer pulls, so a stage never
drains its source to build a result. That also makes abandonment free: a consumer
that stops draining causes `for await` to call `return()` on the stage, which
propagates to its source and on to the transport, so an abandoned pipeline
closes the socket behind it.

In each of them, `index` — the position of the current value — is an integer, so
`index % 2` and `index + 1` work as they read.

## Example

```yaml
kind: Telo.Application
metadata: { name: SeedPipeline, version: 1.0.0 }
imports:
  Stream: oci://ghcr.io/telorun/stream@0.5.0
  PlainText: oci://ghcr.io/telorun/plain-text-codec@0.6.0
  Gzip: oci://ghcr.io/telorun/gzip@0.4.0
  Run: oci://ghcr.io/telorun/run@0.13.0
targets: [ !ref pipeline ]
---
# Stream.Of(strings) → PlainText.Encoder(bytes) → Gzip.Encoder(gzip bytes)
kind: Run.Sequence
metadata: { name: pipeline }
steps:
  - name: source
    invoke: { kind: Stream.Of, items: ["hello telo"] }
  - name: bytes
    inputs: { input: !cel "steps.source.result.output" }
    invoke: { kind: PlainText.Encoder }
  - name: gzip
    inputs: { input: !cel "steps.bytes.result.output" }
    invoke: { kind: Gzip.Encoder }
```
