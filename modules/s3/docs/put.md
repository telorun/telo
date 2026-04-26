---
description: "S3.Put: invocable for uploading objects to bucket with key, body, and optional MIME type"
sidebar_label: S3.Put
---

# S3.Put

> Examples below assume this module is imported with `Telo.Import` alias `S3`. Kind references (`S3.Put`, `S3.Bucket`) follow that alias — if you import the module under a different name, substitute your alias accordingly.

Uploads an object to a bucket declared as `S3.Bucket`. Invocable — invoke per request or inside a `Run.Sequence` step.

---

## Example

```yaml
kind: S3.Put
metadata:
  name: UploadManifest
bucketRef:
  name: ModuleStore
```

Invoke inside a sequence:

```yaml
- name: upload
  invoke:
    kind: S3.Put
    bucketRef:
      name: ModuleStore
  inputs:
    key: "${{ inputs.fileKey }}"
    body: "${{ inputs.body }}"
    contentType: "text/yaml"
```

---

## Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `bucketRef.name` | string | yes | Name of an `S3.Bucket` resource in the same module. |

## Invocation inputs

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `key` | string | yes | Object key (path inside the bucket). |
| `body` | string | yes | Object content. |
| `contentType` | string | no | MIME type. Defaults to `application/octet-stream`. |

## Output

| Field | Type | Description |
|-------|------|-------------|
| `key` | string | The uploaded object's key (echoed back). |
