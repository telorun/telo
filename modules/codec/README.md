# Codec

The `Encoder` and `Decoder` abstracts — `Invocable` contracts that every concrete stream codec implements. Format-specific codec modules (`plain-text-codec`, `ndjson-codec`, `octet-codec`, `sse-codec`) extend these so downstream consumers can write transport-neutral pipelines.

## Why use this

- **Transport-neutral** — write once against `Codec.Encoder` / `Codec.Decoder`; swap the backing format at the import boundary without touching consumer manifests.
- **Stream-first** — both abstracts operate on `AsyncIterable<Uint8Array>` (encoder output) and `AsyncIterable<T>` (decoder output), so memory stays bounded for large payloads.
- **Composes with `Run.Sequence`** — codec invocations slot into pipelines like any other step.

## Kinds (abstracts)

| Kind | Purpose |
| --- | --- |
| `Codec.Encoder` | Abstract: encode an async iterable of records into a byte stream. |
| `Codec.Decoder` | Abstract: decode a byte stream into an async iterable of records (or a single value). |

These are abstracts, not runnable resources — concrete codec modules implement them.

## Example

A consumer reads `Codec.Encoder` polymorphically:

```yaml
kind: Telo.Application
metadata: { name: codec-stream, version: 1.0.0 }
imports:
  Codec: std/codec@latest
  Ndjson: std/ndjson-codec@latest
---
kind: Http.Server
metadata: { name: Stream }
encoders:
  application/x-ndjson: { kind: Ndjson.Encoder, name: Out }
```
