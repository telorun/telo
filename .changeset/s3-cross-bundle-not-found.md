---
"@telorun/s3": patch
---

Fix `S3.Get` surfacing a missing object as a generic 500 instead of
`ERR_NOT_FOUND`. The S3 client lives in the `S3.Bucket` controller's bundle, so
`err instanceof S3ServiceException` in a separately-bundled controller (each
inlines its own copy of `@aws-sdk/client-s3` under `telo install`) was always
false — the not-found branch never ran and the error escaped as
`ERR_EXECUTION_FAILED`. Classify S3 errors structurally (`name` /
`$metadata.httpStatusCode`) instead of by class identity, which is safe across
bundle boundaries.
