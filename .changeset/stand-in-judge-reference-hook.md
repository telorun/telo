---
"@telorun/analyzer": patch
"@telorun/kernel": patch
---

The stand-in judge's schema-node validator now requires a `resolveReference` hook, and the kernel supplies one answering from its primary validator — so a union decided through a schema only the primary instance holds is judged at resource creation instead of failing with "does not compile where it stands".
