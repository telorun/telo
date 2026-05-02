---
"@telorun/s3": minor
---

Add `S3.Get` invocable kind. Reads an object from a bucket declared via `S3.Bucket` and returns `{ output, contentType }` where `output` is a `Stream<Uint8Array>` (annotated with `x-telo-stream: true`) of the object's bytes. Pair `output` with an Encoder (e.g. `Octet.Encoder`) inside an `Http.Api` response to stream a stored object straight onto the wire without buffering. Authentication uses the bucket's existing SigV4 credentials, so consumers no longer need a separate unauthenticated `HttpClient.Client` to proxy reads. Throws `ERR_NOT_FOUND` for missing keys, `ERR_INVALID_REFERENCE` when the bucket alias does not resolve, and `ERR_INVALID_RESPONSE` when the backend returns no iterable body — all enumerated in the kind's `throws.codes` so callers can write typed `catches:` entries.
