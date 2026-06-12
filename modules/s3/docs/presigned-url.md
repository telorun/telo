---
description: "S3.PresignedUrl: invocable that mints a time-limited download or upload link for an object"
sidebar_label: S3.PresignedUrl
---

# S3.PresignedUrl

> Examples below assume this module is imported with an `imports:` entry under alias `S3`. Kind references (`S3.PresignedUrl`, `S3.Bucket`) follow that alias — if you import the module under a different name, substitute your alias accordingly.

Mints a time-limited URL for an object in a bucket declared as `S3.Bucket`,
via SigV4 query presigning — `get` for downloads, `put` for browser-direct
uploads. Pure local crypto — no request leaves the process, and the object's
existence is not checked: a GET URL for a missing key simply 404s when used.

Anyone holding the URL can use it until it expires — treat the returned
`url` as a secret-bearing value (don't log it).

---

## Example

Hand a client a download link instead of proxying the bytes:

```yaml
kind: S3.PresignedUrl
metadata: { name: Share }
bucketRef: !ref DocumentStore
expiresIn: 3600
```

```yaml
- name: link
  inputs:
    key: "${{ inputs.documentId + '.pdf' }}"
  invoke: !ref Share
- name: respond
  inputs:
    url: "${{ steps.link.result.url }}"
    expiresAt: "${{ steps.link.result.expiresAt }}"
  invoke: !ref RespondJson
```

Let a browser upload directly to the bucket — the signed `contentType` means
the uploader must send exactly that header:

```yaml
- name: uploadSlot
  inputs:
    key: "${{ 'incoming/' + inputs.documentId + '.pdf' }}"
    operation: put
    contentType: application/pdf
    expiresIn: 600
  invoke: !ref Share
```

---

## Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `bucketRef` | reference | yes | A `!ref` to an `S3.Bucket` resource — local (`!ref DocumentStore`) or imported (`!ref Alias.DocumentStore`). |
| `operation` | `"get"` \| `"put"` | no (default `get`) | What the link authorizes — download or browser-direct upload. |
| `expiresIn` | integer | no (default `900`) | Link lifetime in seconds; SigV4 caps presigned URLs at 7 days (`604800`). |

## Invocation inputs

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `key` | string | yes | Object key (path inside the bucket); non-empty. |
| `operation` | `"get"` \| `"put"` | no | Takes precedence over the resource-level `operation`. |
| `expiresIn` | integer | no | Link lifetime in seconds. Takes precedence over the resource-level `expiresIn`. |
| `contentType` | string | no | `put` only — bakes the Content-Type into the signature, so the uploader must send exactly this header. Rejected for `get`. |

## Output

| Field | Type | Description |
|-------|------|-------------|
| `url` | string | Time-limited URL authorizing the requested operation on the object. |
| `expiresAt` | string | ISO 8601 timestamp the URL stops working at — read back from the URL's signed `X-Amz-Date` + `X-Amz-Expires`, so it is exact. |

## Errors

| Code | When |
|------|------|
| `ERR_INVALID_INPUT` | `key` is empty; `expiresIn` is not an integer between 1 and 604800 seconds; or `contentType` is supplied for a `get` operation. |
| `ERR_INVALID_REFERENCE` | `bucketRef` does not resolve to a live `S3.Bucket` resource. |
