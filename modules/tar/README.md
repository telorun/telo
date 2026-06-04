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
  Gzip: std/gzip@latest
  Tar: std/tar@latest
---
- name: gunzip
  inputs: { input: "${{ request.body }}" }
  invoke: { kind: Gzip.Decoder, name: Decode }
- name: manifest
  inputs:
    input: "${{ steps.gunzip.result.output }}"
    path: telo.yaml
  invoke: { kind: Tar.Extract, name: Pick }
```
