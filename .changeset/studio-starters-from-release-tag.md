---
"@telorun/studio": patch
---

A released Studio loads its starter gallery from its own release tag's `starters/` instead of main's, so the starters it offers match the telo it ships with. A build without `VITE_TELO_STARTERS_URL` still loads main's.
