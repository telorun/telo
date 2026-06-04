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

> The output is statically an **opaque** stream (no element type), like every
> Telo stream today. Static element-type validation is a planned evolution — see
> the `x-telo-stream: { items }` form and the stream-element-typing plan.

## Example

```yaml
kind: Telo.Application
metadata: { name: seed-pipeline, version: 1.0.0 }
imports:
  Stream: std/stream@latest
  PlainText: std/plain-text-codec@latest
  Gzip: std/gzip@latest
  Run: std/run@latest
---
kind: Stream.Of
metadata: { name: Source }
items: ["hello telo"]
---
# Stream.Of(strings) → PlainText.Encoder(bytes) → Gzip.Encoder(gzip bytes)
- name: source
  invoke: { kind: Stream.Of, name: Source }
- name: bytes
  inputs: { input: "${{ steps.source.result.output }}" }
  invoke: { kind: PlainText.Encoder, name: ToBytes }
- name: gzip
  inputs: { input: "${{ steps.bytes.result.output }}" }
  invoke: { kind: Gzip.Encoder, name: Compress }
```
