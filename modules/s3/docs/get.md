---
description: "S3.Get: invocable that streams an object's bytes from a bucket"
sidebar_label: S3.Get
---

# S3.Get

> Examples below assume this module is imported with `Telo.Import` alias `S3`. Kind references (`S3.Get`, `S3.Bucket`) follow that alias — if you import the module under a different name, substitute your alias accordingly.

Streams an object's bytes from a bucket declared as `S3.Bucket`. Invocable — emits `output` as an async iterable of `Uint8Array` chunks, so downstream consumers stay byte-streaming end-to-end.

The result's `output` property is annotated with `x-telo-stream: true`. Pair it with an Encoder (e.g. `Octet.Encoder` for raw bytes) when wiring through an `Http.Api` response so the body never buffers in memory.

---

## Example

Streaming an S3 object straight onto an HTTP response:

```yaml
- request:
    path: /{namespace}/{name}/{version}/telo.yaml
    method: GET
  handler:
    kind: S3.Get
    bucketRef:
      name: ModuleStore
  inputs:
    key: "${{ request.params.namespace + '/' + request.params.name + '/' + request.params.version + '/telo.yaml' }}"
  returns:
    - status: 200
      mode: stream
      content:
        text/yaml:
          encoder: { kind: Octet.Encoder }
```

Iterating the byte stream inside a sequence:

```yaml
- name: fetchManifest
  invoke:
    kind: S3.Get
    bucketRef:
      name: ModuleStore
  inputs:
    key: "${{ inputs.fileKey }}"
- name: drain
  invoke:
    kind: JS.Script
    name: CollectBytes
  inputs:
    chunks: "${{ steps.fetchManifest.result.output }}"
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

## Output

| Field | Type | Description |
|-------|------|-------------|
| `output` | `Stream<Uint8Array>` | Async iterable of byte chunks streamed from the storage backend. |
| `contentType` | string | Content-Type header reported by the storage backend, when available. |

## Errors

| Code | When |
|------|------|
| `ERR_NOT_FOUND` | The object does not exist under the given key. |
| `ERR_INVALID_REFERENCE` | `bucketRef.name` does not resolve to a live `S3.Bucket` resource. |
| `ERR_INVALID_RESPONSE` | The storage backend returned no iterable body. |
