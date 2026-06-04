# Gzip Codec

Compress and decompress a byte stream. The encoder wraps Node's
`zlib.createGzip()`, the decoder `zlib.createGunzip()`: a `Stream<Uint8Array>`
in, a `Stream<Uint8Array>` out.

## Why use this

- **Streaming** — (de)compression runs as the consumer iterates; the whole
  payload is never buffered.
- **Symmetric** — implements both `Codec.Encoder` and `Codec.Decoder`, so it
  can sit on either side of a stream.
- **Composable** — the output is a byte stream, so it pipes straight into a
  downstream codec (`Tar.Extract` for a `.tar.gz`, `PlainText.Decoder` for a
  gzipped text body).

## Kinds

| Kind | Purpose |
| --- | --- |
| `Gzip.Encoder` | Compress a `Stream<Uint8Array>` into a gzip `Stream<Uint8Array>`. |
| `Gzip.Decoder` | Decompress a gzip `Stream<Uint8Array>` into a decompressed `Stream<Uint8Array>`. |

## Example

```yaml
kind: Telo.Application
metadata: { name: gunzip-upload, version: 1.0.0 }
imports:
  Gzip: std/gzip@latest
  Tar: std/tar@latest
---
# A `.tar.gz` upload: gunzip, then pull one entry out of the archive.
- name: gunzip
  inputs: { input: "${{ request.body }}" }
  invoke: { kind: Gzip.Decoder, name: Decode }
- name: manifest
  inputs:
    input: "${{ steps.gunzip.result.output }}"
    path: telo.yaml
  invoke: { kind: Tar.Extract, name: Pick }
```
