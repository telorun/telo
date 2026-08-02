# Octet Codec

Raw-bytes codec — `Uint8Array` stream ↔ `Uint8Array`. The encoder passes byte chunks through unchanged; the decoder collects every chunk into a single buffer.

## Why use this

- **Pass-through** — for endpoints that already work in bytes (binary uploads, file I/O), no transformation step is needed.
- **Symmetric** — implements both `Codec.Encoder` and `Codec.Decoder`, so it can sit on either side of a stream.
- **Useful as a sentinel** — register `Octet` for `application/octet-stream` content negotiation when the actual payload is opaque.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Octet.Encoder` | Pass an async iterable of `Uint8Array` chunks through unchanged. |
| `Octet.Decoder` | Collect every chunk into a single `Uint8Array`. |

## Example

```yaml
kind: Telo.Application
metadata: { name: octet-uploads, version: 1.0.0 }
imports:
  Octet: oci://ghcr.io/telorun/octet-codec@0.6.0
  Stream: oci://ghcr.io/telorun/stream@0.5.0
  Run: oci://ghcr.io/telorun/run@0.13.0
targets: [ !ref Collect ]
---
kind: Stream.Of
metadata: { name: Chunks }
---
kind: Octet.Decoder
metadata: { name: ReadBytes }
---
kind: Run.Sequence
metadata: { name: Collect }
steps:
  - name: source
    invoke: !ref Chunks
  - name: bytes                 # { bytes: Uint8Array } — every chunk concatenated
    inputs: { input: !cel "steps.source.result.output" }
    invoke: !ref ReadBytes
```
