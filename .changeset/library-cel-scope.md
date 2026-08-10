---
"@telorun/analyzer": patch
---

A library's CEL is no longer validated against the importing application's variable contract.

An application analysis is flattened: `selectModuleManifestsForAnalysis` forwards an imported library's `Telo.Definition` / `Telo.Abstract` / `Telo.Import` docs and the instances named in its `exports.resources`, and drops the library doc itself — so the only module doc in the set is the entry's. The per-resource validation loop already skipped forwarded exports for precisely that reason ("their kind/CEL are authored in that module's scope"); the CEL pass did not, so a forwarded export's `variables.x` was chain-checked against the consumer's `variables:` block.

That was wrong in both directions. A library reading a variable it declares and the app does not reported `CEL_UNKNOWN_FIELD` — a hard error, with no author-side fix, that only appeared once the library was imported and only for reads in a slot carrying an `x-telo-context` (a `Run.Sequence` step's `inputs:`), since a plain resource field types `variables` permissively and never rejects. In the other direction, a library reading a variable it never declared passed silently whenever the app happened to declare that name.

`selectModuleManifestsForAnalysis` now carries the declaring module's `variables` / `secrets` / `ports` blocks across as `metadata.moduleGlobals` — the only point where a manifest and its module doc are both in hand — and the CEL pass types each resource's globals from its own module. The read is still checked; it is checked against the right contract.

Skipping forwarded exports in the CEL pass would not have been equivalent: it retires every other diagnostic for them (`CEL_SYNTAX_ERROR`, `CEL_NULLABLE_ACCESS`, `CEL_IN_NON_EVAL_FIELD`, `UNKNOWN_ENGINE`, `OBSERVED_STATE_*`), and `OBSERVED_STATE_NEVER_RUN` is answerable only in the consumer's analysis, since a library declares no `targets:` of its own.

`resources` is deliberately left open for a forwarded manifest rather than narrowed to a carried name list: the flat list holds only the library's exported instances and no `with:`-scoped ones, so any list built from it would report names that exist as missing.
