---
"@telorun/analyzer": patch
---

A step body whose steps produce no result (only `if:` / `while:` / `switch:` / `throw:`) now has `inputs` in CEL scope, typed from the input contract, and an empty `steps` map, instead of reporting every read as `CEL_UNKNOWN_IDENTIFIER`.
