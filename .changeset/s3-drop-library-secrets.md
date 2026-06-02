---
"@telorun/s3": patch
---

s3: drop the unused `accessKeyId` / `secretAccessKey` library-level `secrets` contract

`std/s3` declared `accessKeyId` and `secretAccessKey` as `Telo.Library` secrets,
which the kernel treats as required inputs for every importer — yet nothing in the
module reads them. Credentials flow per-resource: `S3.Bucket` is a `Telo.Provider`
that takes `accessKeyId` / `secretAccessKey` as its own (compile-evaluated) fields,
and `S3.Get` / `S3.Put` / `S3.List` reuse the bucket's client via `bucketRef`.
Removing the dead contract lets consumers import `std/s3` without passing secrets
that are never used. Docs updated accordingly.
