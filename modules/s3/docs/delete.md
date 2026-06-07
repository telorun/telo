---
description: "S3.Delete: invocable for removing an object from a bucket by key (idempotent)"
sidebar_label: S3.Delete
---

# S3.Delete

> Examples below assume this module is imported with an `imports:` entry under alias `S3`. Kind references (`S3.Delete`, `S3.Bucket`) follow that alias — if you import the module under a different name, substitute your alias accordingly.

Removes an object from a bucket declared as `S3.Bucket`. Invocable — invoke per request or inside a `Run.Sequence` step. Delete is idempotent: removing a key that does not exist still succeeds.

---

## Example

```yaml
kind: S3.Delete
metadata:
  name: RemoveObject
bucketRef: !ref ModuleStore
```

Invoke inside a sequence:

```yaml
- name: remove
  invoke:
    kind: S3.Delete
    bucketRef: !ref ModuleStore
  inputs:
    key: "${{ inputs.objectKey }}"
```

---

## Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `bucketRef` | reference | yes | A `!ref` to an `S3.Bucket` resource — local (`!ref ModuleStore`) or imported (`!ref Alias.ModuleStore`). |

## Invocation inputs

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `key` | string | yes | Object key (path inside the bucket) to delete. |

## Output

| Field | Type | Description |
|-------|------|-------------|
| `key` | string | The deleted object's key (echoed back). |

## Errors

| Code | When |
|------|------|
| `ERR_INVALID_REFERENCE` | `bucketRef` does not resolve to a live `S3.Bucket` at invoke time. |
