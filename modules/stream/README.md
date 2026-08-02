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

> The output is statically an **opaque** stream (no element type), like every
> Telo stream today. Static element-type validation is a planned evolution — see
> the `x-telo-stream: { items }` form and the stream-element-typing plan.

## Example

```yaml
kind: Telo.Application
metadata: { name: seed-pipeline, version: 1.0.0 }
imports:
  Stream: oci://ghcr.io/telorun/stream@0.5.0
  PlainText: oci://ghcr.io/telorun/plain-text-codec@0.6.0
  Gzip: oci://ghcr.io/telorun/gzip@0.4.0
  Run: oci://ghcr.io/telorun/run@0.13.0
targets: [ !ref Pipeline ]
---
kind: Stream.Of
metadata: { name: Source }
items: ["hello telo"]
---
kind: PlainText.Encoder
metadata: { name: ToBytes }
---
kind: Gzip.Encoder
metadata: { name: Compress }
---
# Stream.Of(strings) → PlainText.Encoder(bytes) → Gzip.Encoder(gzip bytes)
kind: Run.Sequence
metadata: { name: Pipeline }
steps:
  - name: source
    invoke: !ref Source
  - name: bytes
    inputs: { input: !cel "steps.source.result.output" }
    invoke: !ref ToBytes
  - name: gzip
    inputs: { input: !cel "steps.bytes.result.output" }
    invoke: !ref Compress
```
