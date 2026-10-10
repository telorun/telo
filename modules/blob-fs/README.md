# Blob FS

`blob-fs` — a blob store on a directory. `BlobFs.Store` implements
[`Blob.Store`](../blob/README.md), so `Blob.Put`, `Blob.Get`, `Blob.Head` and
`Blob.Delete` keep their content as plain files under one root — on local disk,
or on a volume several processes mount.

## Why use this

- **Nothing to run.** A directory is the whole dependency: no service, no
  credentials, and tests run on a clean checkout.
- **Shared by whoever mounts it.** Every process given the same `root` is one
  store; a blob one replica stores, another reads.
- **Whole objects only.** A put is staged, flushed to disk and renamed into
  place. A reader sees the old blob or the new one, a failed or oversized upload
  leaves nothing behind, and concurrent puts to one key leave exactly one of
  them.
- **Any valid key.** The file name is derived from a hash of the key, so a key's
  length, depth and letter case never meet a limit of the filesystem.

## Kinds

| Name | What it is |
| --- | --- |
| [`BlobFs.Store`](docs/store.md) | A `Blob.Store` over a directory. One field: `root`. |

## Example

```yaml
kind: Telo.Application
metadata: { name: Attachments, version: 1.0.0 }
imports:
  Blob: oci://ghcr.io/telorun/blob@<version>
  BlobFs: oci://ghcr.io/telorun/blob-fs@<version>
variables:
  blobRoot:
    env: BLOB_ROOT
    type: string
    x-telo-type: Telo.HostPath
    default: data/blobs
---
kind: BlobFs.Store
metadata: { name: attachments }
root: !cel "variables.blobRoot"
---
kind: Blob.Put
metadata: { name: saveAttachment }
store: !ref attachments
---
kind: Blob.Get
metadata: { name: readAttachment }
store: !ref attachments
```

`saveAttachment` and `readAttachment` are then invoked like any other operation —
see [the blob operations](../blob/docs/operations.md).

## Reference

- [`BlobFs.Store`](docs/store.md) — the `root` field, the on-disk layout and file
  format, how a put is committed, and what the store does not do.
