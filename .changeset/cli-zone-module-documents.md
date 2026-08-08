---
"@telorun/cli": minor
---

`telo check` now reports execution-zone diagnostics: a statement declaring a
`transaction:` wired onto a path that reaches it outside any transaction is an
error at check time rather than a throw the first time that route is exercised.

The command feeds the analyzer each imported library's full documents
(`collectZoneModuleDocuments`) alongside the flattened manifest list. The
flattened view carries only each library's export surface, never its internal
dispatch chain, so without this the zone stage cannot derive what an exported
resource requires of its importers — and `ZONE_EXPORT_UNSATISFIABLE` would
never fire at the library that owns the fix.
