---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/sdk": minor
---

Enforce the `exports.kinds` gate statically. The analyzer's gate was dead code — it read `exports.kinds` off the `Telo.Import` doc, which has no such field, so the list was always empty and no unexported kind was ever rejected. `flattenForAnalyzer` now stamps the target library's resolved `exports.kinds` (re-exports included) onto each `Telo.Import` as `metadata.exportedKinds`, and the analyzer registers it, so `telo check` agrees with the kernel instead of being silently more permissive.

An unexported kind now reports `KIND_NOT_EXPORTED` naming the module and its exported kinds, rather than an `UNDEFINED_KIND` whose "did you mean" echoed back the kind just rejected.

`registerImport` / `registerModuleImport` take `kinds?: readonly string[]`, separating cases the previous empty array conflated: a declared gate (`["A"]`), a gate that exports nothing (`[]`), and a target declaring no `exports.kinds` at all (`undefined`, the legacy permissive default). This is the groundwork for making kinds private by default; that default is unchanged for now, since already-published module versions cannot gain the block retroactively.

The gate is consulted before any definition-registry lookup. The registry is keyed `<module>.<Kind>`, so a library whose `metadata.name` equals the alias it is imported under made the raw kind string a valid key — the definition resolved directly and an unexported kind was accepted, while the kernel threw at boot.

`resolveExportedKinds` distinguishes a module that declares no `exports.kinds` from one that declares an empty list, so a re-export (`exports.kinds: [Alias.Kind]`) whose source module is ungated still resolves, matching the kernel instead of rejecting a manifest that runs.

`registerUngatedAlias` replaces the ungated form of `registerImport` for `Self` and the `Telo` built-ins. Those cross no import boundary and must never be gated; keeping them on a separate method leaves the legacy permissive import as the only remaining ungated `registerImport` call, so making kinds private by default is a single greppable site.

`AnalysisRegistry.registerImport` takes the gate as optional too, and gains `registerUngatedAlias`, so IDE/editor consumers express the same three intents as the kernel.
