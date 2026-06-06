---
"@telorun/kernel": patch
"@telorun/analyzer": minor
---

Instantiating an abstract kind directly (e.g. `kind: Sql.Connection`) now fails with a clear message — "Kind 'X' is abstract and cannot be instantiated directly; instantiate a concrete implementation: …" — listing the concrete kinds that extend it, instead of the generic "No controller registered". Adds `AnalysisRegistry.implementationsOf(kind)`.
