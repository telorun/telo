---
"@telorun/kernel": patch
"@telorun/sdk": patch
"@telorun/cli": patch
"@telorun/ide-support": patch
---

`telo run` points a manifest error at its line again, exactly as `telo check` does.

A failure the kernel raises from static analysis converted the analyzer's diagnostics into `RuntimeDiagnostic`s while dropping their `data` — the file, the field path within it, and the owning resource. That is precisely what `findPositions` resolves a position from, so the CLI had nothing left to locate and printed the message alone. The same manifest checked with `telo check` still named the line, which made the two commands disagree about the same error.

`RuntimeDiagnostic` gains `origin` (`DiagnosticOrigin`: `filePath`, field `path`, `resource`, and the diagnostic's own `range`), carried through verbatim so a renderer resolves `file:line:col` against the loaded graph rather than re-parsing a rendered message. `range` is what locates a failure with no field path to look up: a YAML parse error knows where the syntax broke but has no parsed tree to index.

All four raise sites now go through one mapper (`static-analysis-diagnostics.ts`, sibling of the init-failure one): the pre-flight validation pass, Phase-3 reference resolution, YAML parse failures, and major-version conflicts. The last two used to flatten their diagnostics into a joined message string, so a syntax error and a bad `imports:` pin were the two failures `run` could not locate at all. Their `error.message` is unchanged for consumers that only read it. The loaded graph is now recorded before the parse-failure throw, since that is the failure that most needs to name a line.

The position itself comes from `resolveRange`, the rule the VS Code extension already uses, rather than a third copy of it in the CLI: it walks parent paths when the exact field path is absent from the index (an `imports.<alias>` conflict lands on the import entry) and prefers an entry's key over its value. `resolveRange` now takes just the position half of a `DiagnosticContext`, so a caller holding only a located file does not have to invent an `AnalysisRegistry` to reuse it. A located static failure renders byte-identically under `run` and `check`. A diagnostic nothing can locate falls back to naming the resource rather than pointing at line 1 — a wrong line sends the reader somewhere the error is not. Runtime failures are unchanged: they are pinned to a resource, not to a spot in the YAML, and keep the kind + name form.
