---
"@telorun/kernel": patch
---

Under Bun, an emitted CEL module is imported from its own text instead of by path, so a module written into the cache after another was imported from the same directory is found. On macOS a child application started in the same process could not load its compiled expressions.
