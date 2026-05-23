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
kind: Telo.Import
metadata: { name: Octet }
source: std/octet-codec@latest
---
kind: Http.Server
metadata: { name: Uploads }
decoders:
  application/octet-stream: { kind: Octet.Decoder, name: ReadBytes }
```
