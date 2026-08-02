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
  Gzip: oci://ghcr.io/telorun/gzip@0.4.0
  Tar: oci://ghcr.io/telorun/tar@0.4.0
  PlainText: oci://ghcr.io/telorun/plain-text-codec@0.6.0
  Run: oci://ghcr.io/telorun/run@0.13.0
targets: [ !ref ReadManifest ]
---
kind: Gzip.Decoder
metadata: { name: Decode }
---
kind: Tar.Extract
metadata: { name: Pick }
---
kind: PlainText.Decoder
metadata: { name: ToText }
---
# A `.tar.gz` payload: gunzip, pull one entry out of the archive, read it as text.
kind: Run.Sequence
metadata: { name: ReadManifest }
inputs:
  archive: {}                   # a Stream<Uint8Array> — an upload, a file read, …
steps:
  - name: gunzip
    inputs: { input: !cel "inputs.archive" }
    invoke: !ref Decode
  - name: manifest
    inputs:
      input: !cel "steps.gunzip.result.output"
      path: telo.yaml
    invoke: !ref Pick
  - name: text
    inputs: { input: !cel "steps.manifest.result.output" }
    invoke: !ref ToText
outputs:
  manifest: !cel "steps.text.result.text"
```
