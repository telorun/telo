---
"@telorun/analyzer": patch
---

Add `AnalysisRegistry.aliasesFor(moduleName)` (and the underlying `AliasResolver.aliasesFor`) so callers can convert a canonical kind key (e.g. `http-server.Server`) back into its user-facing import alias form (e.g. `Http.Server`). Used by the VS Code extension to stop suggesting invalid canonical kinds in `kind:` autocomplete.
