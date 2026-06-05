# YAML

Batch YAML parsing for Telo manifests. Multi-document-aware, returns plain JS values.

## Why use this

- **Multi-doc native** — `yaml.parseAllDocuments` under the hood; single-doc input still lands in `docs[0]`.
- **Plain JS values** — output is regular objects, arrays, and scalars — no proxy or wrapper types.
- **Typed errors** — invalid YAML surfaces as `ERR_PARSE_FAILED` with the original parser error (line/column when available) preserved on `data`.
- **Batch, not stream** — built as a `Telo.Invocable` because parsing needs the whole document; no stream-codec overhead.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Yaml.Parse` | UTF-8 string in, `{ docs: unknown[] }` out. Each entry mirrors the source document's top-level value. |

## Example

```yaml
kind: Telo.Application
metadata: { name: parse-demo }
imports:
  Yaml: std/yaml@0.4.1
  Run: std/run@0.5.0
targets: [ ParseExample ]
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
  firstKind: ${{ steps.parse.result.docs[0].kind }}
```

## Reference

- [`Yaml.Parse`](docs/parse.md) — parse a UTF-8 YAML string into one or more documents.

## Why a dedicated module (and not a codec)?

The format-codec abstracts (`Codec.Encoder` / `Codec.Decoder`) are stream-oriented — they carry `Stream<Uint8Array>` end-to-end so manifests can pipe bytes without buffering. YAML parsing is fundamentally batch: the parser needs the whole document before it can build the syntax tree, so a stream-typed input/output adds nothing. `Yaml.Parse` is therefore a plain `Telo.Invocable`, not a `Codec.Decoder`.

## Roadmap

- `Yaml.Stringify` (object → string) lands when the first consumer needs it.
