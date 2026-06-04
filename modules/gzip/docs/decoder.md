---
description: "Gzip.Decoder: gunzip a byte stream into a decompressed byte stream"
sidebar_label: Gzip.Decoder
---

# Gzip.Decoder

> Examples below assume this module is imported with an `imports:` entry under alias `Gzip`. Kind references follow that alias — substitute your own if you import it under a different name.

Decompresses a gzip `Stream<Uint8Array>` into a decompressed `Stream<Uint8Array>`, wrapping Node's `zlib.createGunzip()`. Implements the `Codec.Decoder` contract. The output stays a stream so it pipes directly into a downstream decoder.

---

## Example

```yaml
- name: gunzip
  inputs: { input: "${{ request.body }}" }
  invoke: { kind: Gzip.Decoder, name: Decode }
```

---

## Invocation inputs

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `input` | `Stream<Uint8Array>` | yes | Gzip-compressed byte stream. |

## Output

| Field | Type | Description |
|-------|------|-------------|
| `output` | `Stream<Uint8Array>` | Decompressed byte stream. Pipe into another decoder or sink. |
