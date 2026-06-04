---
description: "Gzip.Encoder: compress a byte stream into a gzip byte stream"
sidebar_label: Gzip.Encoder
---

# Gzip.Encoder

> Examples below assume this module is imported with an `imports:` entry under alias `Gzip`. Kind references follow that alias — substitute your own if you import it under a different name.

Compresses a `Stream<Uint8Array>` into a gzip `Stream<Uint8Array>`, wrapping Node's `zlib.createGzip()`. Implements the `Codec.Encoder` contract. The output stays a stream so it pipes directly into a sink (an HTTP response, `S3.Put`, …).

---

## Example

```yaml
- name: compress
  inputs: { input: "${{ steps.pack.result.output }}" }
  invoke: { kind: Gzip.Encoder, name: Compress }
```

---

## Invocation inputs

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `input` | `Stream<Uint8Array>` | yes | Uncompressed byte stream. |

## Output

| Field | Type | Description |
|-------|------|-------------|
| `output` | `Stream<Uint8Array>` | Gzip-compressed byte stream. |
