---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/sdk": minor
"@telorun/cli": patch
"@telorun/assert": patch
---

inline imports — `imports:` map on Telo.Application / Telo.Library

Add an optional name-keyed `imports:` map to `Telo.Application` and
`Telo.Library` as additive sugar for separate `Telo.Import` documents. Each
entry's key is the PascalCase alias; its value is either a bare source string
(`Console: std/console@1.2.3`, shorthand for `{ source }`) or the full object
form carrying `variables` / `secrets` / `runtime`. Authored `Telo.Import`
documents keep working unchanged and both forms may coexist.

The loader desugars inline entries into synthetic `Telo.Import` manifests via a
new `desugarImports` `LoadOptions` flag (folded into the file cache key; mirrored
on the SDK's `ResourceContext.loadModule` options). The flag is on for every
resolved consumer — the kernel's analysis and runtime loads, the
import-controller's child-module load, the analyzer, `telo check`, and the
`Assert.Manifest` test helper — and off for the editor's round-trip view, which
reads the raw `imports:` map and pairs manifests to YAML nodes by index. Inline
imports therefore resolve and execute identically to authored docs.

Adds a `DUPLICATE_IMPORT_ALIAS` diagnostic: an alias declared twice in one
module scope (across either form) is now an error instead of silently
shadowing.
