---
"@telorun/s3": minor
---

Add `S3.Delete` (idempotent object delete by key), rounding the module out to a complete object-CRUD set. Widen `S3.Put`'s `body` to accept buffered binary (`Uint8Array`, e.g. the `bytes` from `Octet.Decoder`) in addition to a UTF-8 string.
