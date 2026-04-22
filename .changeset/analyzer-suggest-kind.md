---
"@telorun/analyzer": minor
---

Add `AnalysisRegistry.validUserFacingKinds()` and `AnalysisRegistry.suggestKind(badKind)` for editor hosts and diagnostic enrichment. The `UNDEFINED_KIND` diagnostic now appends a `Did you mean '…'?` hint when a close-by valid kind exists (Levenshtein over the alias-form kind list, case-sensitive) and stamps `data.suggestedKind` on the payload so editor hosts can wire CodeActions without re-running the search. The previous verbose `Known imports: … | kinds: …` suffix is removed; CLI users get the concrete suggestion instead.
