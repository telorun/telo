# Tar

Tar archive read/write. `Tar.Extract` pulls one named entry out of a tar byte
stream; `Tar.Pack` builds an archive from an ordered list of `{ path, contents }`
entries. Pair with the gzip codec to read or write a `.tar.gz`.

## Why use this

- **Targeted** — extract a single known entry (e.g. a manifest) without
  materializing the whole archive into the manifest layer.
- **Composable** — both kinds work in byte streams, so they pipe into any
  codec (`Gzip.Encoder`/`Gzip.Decoder`, `PlainText.Decoder`, …).

## Kinds

| Kind | Purpose |
| --- | --- |
| `Tar.Pack` | Build a tar `Stream<Uint8Array>` from an ordered list of `{ path, contents }` entries. |
| `Tar.Extract` | Extract one named entry from a tar `Stream<Uint8Array>` as a byte stream. |

> Whole-archive enumeration (a record stream of every entry) is intentionally
> out of scope until stream element-typing lands; callers that need to walk a
> full archive should do so in their own runtime, not the manifest layer.

## Example

```yaml
kind: Telo.Application
metadata: { name: read-targz, version: 1.0.0 }
imports:
  Gzip: std/gzip@0.4.0
  Tar: std/tar@0.4.0
  PlainText: std/plain-text-codec@0.6.0
  Run: std/run@0.13.0
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
