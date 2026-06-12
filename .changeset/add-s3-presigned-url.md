---
"@telorun/s3": minor
---

New `S3.PresignedUrl` kind — mints a time-limited URL for an object via SigV4
query presigning (`@aws-sdk/s3-request-presigner`): `get` for downloads, `put`
for browser-direct uploads (with an optionally signed Content-Type). Pure
local crypto: no request leaves the process and the object's existence is not
checked. Expiry defaults to 900 s, configurable per resource and overridable
per invocation, capped at the SigV4 limit of 7 days; the reported `expiresAt`
is read back from the URL's signed `X-Amz-Date` + `X-Amz-Expires`. Also
aligns `@aws-sdk/client-s3` to the presigner's release line.
