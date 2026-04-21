---
"@telorun/s3": patch
---

`S3.Bucket` with `createIfMissing: true` now issues a `HeadBucketCommand` first and only calls `CreateBucketCommand` when the head returns 404. This avoids the spurious create-then-catch round trip against providers that log "bucket exists" attempts loudly (R2, MinIO). The existing `BucketAlreadyOwnedByYou` / `BucketAlreadyExists` catch is kept as a guard against a head-vs-create race.
