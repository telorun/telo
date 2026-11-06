# Key format

A key is `<prefix>_<id><secret><checksum>`, all base 62 (`0-9A-Za-z`, digits first, then upper case, then lower case):

| Part | Length | What it is |
| --- | --- | --- |
| `prefix` | 2 to 15 | The key family, lower-case letters and digits (`svc`). It routes the key to its source, and lets a leaked key be recognised by scanners. |
| `id` | 22 | A UUIDv7's 128 bits. Time-ordered, so keys sort by creation. |
| `secret` | 43 | 256 random bits. |
| `checksum` | 6 | The CRC-32 (IEEE) of everything before it, prefix and underscore included. |

The record's **public id** is `apk_` followed by the same 22 characters. It is what is shown in listings, put in `claims.apiKeyId` and passed to `ApiKey.Revoke` and `ApiKey.Rotate`. A store addresses the key by the UUID the characters spell, and never stores the key.

The **digest** is the SHA-256 of the whole key text, base64url without padding (43 characters). It is compared with the stored one in constant time. A 256-bit random secret gains nothing from a slow password hash, and running one on every request would be expensive.

A key whose shape or checksum is wrong is refused as `malformed` before any source is asked, so mistyped and truncated keys cost no read.

Fixed vectors the implementation is pinned to: the CRC-32 of `123456789` is `cbf43926`, written `3jZRME`; the id bytes `00 01 … 0f` are `000SYW7RiJxkEgOGusQGwp`; the largest 128-bit value is `7n42DGM5Tflk9n8mt7Fhc7`.
