---
description: "Tar.Pack: build a tar byte stream from an ordered list of { path, contents } entries"
sidebar_label: Tar.Pack
---

# Tar.Pack

> Examples below assume this module is imported with an `imports:` entry under alias `Tar`. Kind references follow that alias — substitute your own if you import it under a different name.

Builds a tar archive from an ordered list of `{ path, contents }` entries and emits it as a `Stream<Uint8Array>`. Counterpart to `Tar.Extract`. Pipe the output through `Gzip.Encoder` for a `.tar.gz`.

---

## Example

```yaml
- name: pack
  inputs:
    entries:
      - path: telo.yaml
        contents: "name: hello"
  invoke: { kind: Tar.Pack, name: Build }
- name: compress
  inputs: { input: "${{ steps.pack.result.output }}" }
  invoke: { kind: Gzip.Encoder, name: Gzip }
```

---

## Invocation inputs

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `entries` | array of `{ path, contents }` | yes | Files to write, in order. |
| `entries[].path` | string | yes | Entry path inside the archive. |
| `entries[].contents` | string | yes | UTF-8 text content of the entry. |

## Output

| Field | Type | Description |
|-------|------|-------------|
| `output` | `Stream<Uint8Array>` | Tar archive byte stream. |
