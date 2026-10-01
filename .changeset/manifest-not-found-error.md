---
"@telorun/analyzer": minor
---

A manifest fetch answered `404` or `410` now throws the new exported `ManifestNotFoundError`, carrying the `url` fetched and the `status`, so a caller can tell "not published there" from a transport failure without reading the message. The message is unchanged, and every other non-OK status is still a plain `Error`.
