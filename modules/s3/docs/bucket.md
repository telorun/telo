---
sidebar_label: S3.Bucket
---

# S3.Bucket

Declares an S3-compatible bucket. Constructs and owns the S3 client used by `S3.Put`, `S3.List`, and any other resource that references it via `bucketRef`. Works against AWS S3, Cloudflare R2, MinIO, RustFS, or any other S3-compatible endpoint.

`S3.Bucket` is a `Telo.Provider` — its snapshot exposes nothing publicly; other resources reach it through `bucketRef: { name: ... }`.

---

## Example

```yaml
kind: Telo.Import
metadata:
  name: S3
source: ../modules/s3
secrets:
  accessKeyId: "${{ resources.AppConfig.accessKeyId }}"
  secretAccessKey: "${{ resources.AppConfig.secretAccessKey }}"
---
kind: S3.Bucket
metadata:
  name: ModuleStore
bucketName: "${{ resources.AppConfig.bucketName }}"
endpoint: "${{ resources.AppConfig.s3Endpoint }}"
forcePathStyle: true
accessKeyId: "${{ resources.AppConfig.accessKeyId }}"
secretAccessKey: "${{ resources.AppConfig.secretAccessKey }}"
createIfMissing: true
```

---

## Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `bucketName` | string | yes | Name of the bucket. |
| `endpoint` | string | yes | S3 endpoint URL. Examples: `https://s3.amazonaws.com`, `https://<accountId>.r2.cloudflarestorage.com`, `http://storage:9000`. |
| `accessKeyId` | string | yes | Access key. Typically wired from the module's `accessKeyId` secret. |
| `secretAccessKey` | string | yes | Secret key. Typically wired from the module's `secretAccessKey` secret. |
| `forcePathStyle` | boolean | no | Use path-style URLs (`endpoint/bucket/key`) instead of virtual-host style. Required for MinIO, RustFS, and most self-hosted S3. Defaults to `false`. |
| `createIfMissing` | boolean | no | When `true`, the controller issues `CreateBucket` during init and silently tolerates `BucketAlreadyOwnedByYou` / `BucketAlreadyExists`. Intended for self-hosted/dev backends. Leave `false` on managed clouds where the app may lack `CreateBucket` permission. Defaults to `false`. |

---

## Credentials

The module declares `accessKeyId` and `secretAccessKey` as module-level `secrets`. Importers supply them once in the `Telo.Import` block; individual `S3.Bucket` resources then forward them via CEL:

```yaml
accessKeyId: "${{ resources.AppConfig.accessKeyId }}"
secretAccessKey: "${{ resources.AppConfig.secretAccessKey }}"
```

Wire them from a `Config.Env` provider (or any secret source) in the importing module.

---

## `createIfMissing`

A convenience for local development and self-hosted storage. When set, init calls `CreateBucketCommand` against the configured endpoint; if the bucket already exists (either owned by this account or globally, depending on backend), the error is swallowed and init proceeds.

Any other error (auth failure, network, endpoint misconfiguration) fails init — which is the desired behavior, since a broken bucket would otherwise only surface on the first `S3.Put` call at runtime.

Leave `createIfMissing: false` (the default) for production deployments on AWS S3 or Cloudflare R2, where bucket lifecycle is managed out-of-band and the runtime identity typically cannot create buckets.
