# YAML

Batch YAML parsing for Telo manifests. Multi-doc-aware, returns plain JS values.

## Kinds

- [`Yaml.Parse`](./docs/parse.md) — UTF-8 string → `{ docs: unknown[] }`. Each entry mirrors the source document's top-level value (typically an object, but YAML permits scalars and arrays at the document root). Single-doc callers read `docs[0]`; multi-doc files land in source order.

## Why a dedicated module (and not a codec)?

The format-codec abstracts (`Codec.Encoder` / `Codec.Decoder`) are
stream-oriented — they carry `Stream<Uint8Array>` end-to-end so manifests can
pipe bytes without buffering. YAML parsing is fundamentally batch: the parser
needs the whole document before it can build the syntax tree, so a stream-typed
input/output adds nothing. `Yaml.Parse` is therefore a plain `Telo.Invocable`,
not a `Codec.Decoder`.

## Minimal example

```yaml
kind: Telo.Application
metadata: { name: parse-demo }
targets: [ParseExample]
---
kind: Telo.Import
metadata: { name: Yaml }
source: ../modules/yaml
---
kind: Telo.Import
metadata: { name: Run }
source: ../modules/run
---
kind: Run.Sequence
metadata: { name: ParseExample }
steps:
  - name: parse
    invoke: { kind: Yaml.Parse }
    inputs:
      text: |
        kind: Telo.Library
        metadata: { name: example }
outputs:
  firstKind: ${{ steps.parse.result.docs[0].kind }}   # "Telo.Library"
```

## Roadmap

- `Yaml.Stringify` (object → string) lands when the first consumer needs it.
