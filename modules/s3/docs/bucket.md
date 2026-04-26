---
description: "S3.Bucket: S3-compatible bucket provider for AWS S3, Cloudflare R2, MinIO with endpoint, credentials, and path style options"
sidebar_label: S3.Bucket
---

# S3.Bucket

> Examples below assume this module is imported with `Telo.Import` alias `S3`. Kind references (`S3.Bucket`, `S3.Put`, `S3.List`) follow that alias — if you import the module under a different name, substitute your alias accordingly.

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
| `publicRead` | boolean | no | When `true`, the controller applies a bucket policy during init that grants anonymous `s3:GetObject` on all keys. Defaults to `false`. See [`publicRead`](#publicread). |

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

---

## `publicRead`

When `true`, the controller issues `PutBucketPolicy` during init with a policy granting anonymous `s3:GetObject` on all keys:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::<bucketName>/*"
    }
  ]
}
```

The policy is applied regardless of `createIfMissing`, so it works for both newly created and pre-existing buckets. The policy grants read access only — `ListBucket` is not included, so the bucket index is not browsable; callers must know the object key.

**Backend support:**

- **AWS S3** — works. Bucket-level "Block Public Access" must be disabled out of band; the controller does not touch that setting.
- **MinIO, RustFS** — works. Equivalent to `mc anonymous set download` on MinIO.
- **Cloudflare R2** — not effective. R2 does not honor bucket policies via the S3 API; public access must be configured through the Cloudflare dashboard (custom domain / public bucket URL). Setting `publicRead: true` against R2 will either no-op or error depending on the region.
