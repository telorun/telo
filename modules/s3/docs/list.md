---
description: "S3.List: invocable for listing object keys in bucket with optional key prefix filter"
sidebar_label: S3.List
---

# S3.List

> Examples below assume this module is imported with an `imports:` entry under alias `S3`. Kind references (`S3.List`, `S3.Bucket`) follow that alias — if you import the module under a different name, substitute your alias accordingly.

Lists object keys in a bucket declared as `S3.Bucket`. Invocable.

---

## Example

```yaml
kind: S3.List
metadata:
  name: ListModules
bucketRef: !ref ModuleStore
```

Invoke with an optional key prefix:

```yaml
- name: list
  invoke:
    kind: S3.List
    bucketRef: !ref ModuleStore
  inputs:
    prefix: "${{ 'std/' + inputs.name + '/' }}"
```

---

## Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `bucketRef` | reference | yes | A `!ref` to an `S3.Bucket` resource — local (`!ref ModuleStore`) or imported (`!ref Alias.ModuleStore`). |

## Invocation inputs

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `prefix` | string | no | Restrict the listing to keys starting with this prefix. Defaults to `""` (list all). |

## Output

| Field | Type | Description |
|-------|------|-------------|
| `keys` | string[] | Keys of the objects returned by the underlying `ListObjects` call. |
