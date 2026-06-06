---
description: "S3.Put: invocable for uploading objects to bucket with key, body, and optional MIME type"
sidebar_label: S3.Put
---

# S3.Put

> Examples below assume this module is imported with an `imports:` entry under alias `S3`. Kind references (`S3.Put`, `S3.Bucket`) follow that alias — if you import the module under a different name, substitute your alias accordingly.

Uploads an object to a bucket declared as `S3.Bucket`. Invocable — invoke per request or inside a `Run.Sequence` step.

---

## Example

```yaml
kind: S3.Put
metadata:
  name: UploadManifest
bucketRef: !ref ModuleStore
```

Invoke inside a sequence:

```yaml
- name: upload
  invoke:
    kind: S3.Put
    bucketRef: !ref ModuleStore
  inputs:
    key: "${{ inputs.fileKey }}"
    body: "${{ inputs.body }}"
    contentType: "text/yaml"
```

---

## Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `bucketRef` | reference | yes | A `!ref` to an `S3.Bucket` resource — local (`!ref ModuleStore`) or imported (`!ref Alias.ModuleStore`). |

## Invocation inputs

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `key` | string | yes | Object key (path inside the bucket). |
| `body` | string \| Uint8Array | yes | Object content — a UTF-8 string, or buffered binary (e.g. the `bytes` from `Octet.Decoder`). |
| `contentType` | string | no | MIME type. Defaults to `application/octet-stream`. |

## Output

| Field | Type | Description |
|-------|------|-------------|
| `key` | string | The uploaded object's key (echoed back). |
