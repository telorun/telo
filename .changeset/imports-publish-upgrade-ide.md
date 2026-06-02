---
"@telorun/cli": patch
"@telorun/ide-support": patch
---

cli + ide-support: operate on the inline `imports:` map instead of standalone `Telo.Import` documents

`telo upgrade` and `telo publish` now read and rewrite import sources from the
`imports:` map on the `Telo.Application` / `Telo.Library` doc, covering both the
scalar shorthand (`Alias: <src>`) and the object form (`Alias: { source: <src>, … }`).
Standalone `Telo.Import` document handling is dropped from both commands. `upgrade`
keeps its byte-level splice (quote style, comments, and folded block scalars are
preserved); `publish` canonicalizes relative `imports:` sources to
`<namespace>/<name>@<version>` and now loads the pre-flight analysis graph with
`desugarImports` so inline imports resolve during static validation. `telo install`
likewise loads its graph with `desugarImports`, so transitive inline imports are
discovered, cached, and analyzed.

ide-support source autocomplete fires on `imports:` entries (scalar value or the
`source:` under the object form), gated on the enclosing path so unrelated `source:`
fields never trigger it. `Telo.Import` is removed from the no-registry kind
completion fallback.
