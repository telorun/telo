---
description: "Tar.Extract: pull one named entry out of a tar byte stream as a Stream<Uint8Array>"
sidebar_label: Tar.Extract
---

# Tar.Extract

> Examples below assume this module is imported with an `imports:` entry under alias `Tar`. Kind references follow that alias — substitute your own if you import it under a different name.

Extracts one named entry from a tar `Stream<Uint8Array>` and emits its contents as a `Stream<Uint8Array>`. The archive is scanned to completion; the matched entry is buffered and re-emitted as a single-chunk stream so the result composes with any downstream decoder. A missing entry raises `ERR_NOT_FOUND`.

---

## Example

```yaml
- name: manifest
  inputs:
    input: "${{ steps.gunzip.result.output }}"
    path: telo.yaml
  invoke: { kind: Tar.Extract, name: Pick }
```

---

## Invocation inputs

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `input` | `Stream<Uint8Array>` | yes | Tar archive byte stream (gunzip a `.tar.gz` first). |
| `path` | string | yes | Entry path to extract. A leading `./` is ignored. |

## Output

| Field | Type | Description |
|-------|------|-------------|
| `output` | `Stream<Uint8Array>` | Byte stream of the extracted entry's contents. |

## Errors

| Code | When |
|------|------|
| `ERR_NOT_FOUND` | No entry at `path` exists in the archive. |
| `ERR_INVALID_INPUT` | `input` is not a byte stream, or `path` is missing/empty. |
