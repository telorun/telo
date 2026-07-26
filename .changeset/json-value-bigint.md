---
"@telorun/sdk": minor
---

Add `encodeJsonValue` / `decodeJsonValue` — JSON encoding for values that cross
a persistence boundary.

`JSON.stringify` throws on a BigInt, and CEL integers surface as BigInt in this
runtime, so any controller persisting a CEL-computed result hits it. BigInt is
encoded as a tagged object rather than a string or a Number: a string comes back
a different type than went in, and Number is lossy past 2^53 — a replayed value
must equal the freshly-produced one.
