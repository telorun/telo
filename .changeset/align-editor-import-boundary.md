---
"@telorun/analyzer": minor
"@telorun/editor": patch
---

Align the telo-editor's static-analysis projection with the CLI's import boundary. Extract `flattenForAnalyzer`'s local/foreign forwarding rule into a shared `selectModuleManifestsForAnalysis` helper so the editor and the CLI cannot drift, and have the editor apply it per closure: the closure root stays fully local while imported modules forward only their definitions/abstracts/imports plus `exports.resources` instances (flagged `forwardedExport`). The editor now also anchors a closure at every workspace-local module (not just Applications), so a library imported by an app is validated in its own scope instead of the consumer's. Fixes cross-module `!ref Alias.export` (e.g. a flat `targets` invoke step) reporting spurious `SCHEMA_VIOLATION` / `UNDEFINED_KIND` in the editor while passing `telo check`.
