---
"@telorun/analyzer": patch
"@telorun/language-server": patch
---

`DUPLICATE_IMPORT_ALIAS` no longer fires across two different instances of the same-named module reached through different sources in one graph (a local checkout alongside its own published artifact) — a diamond the kernel already tolerates as two module scopes. The check now keys on the declaring instance, not just the declaring module's name, so only an alias actually repeated within one file still errors.
