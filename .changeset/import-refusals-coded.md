---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/sdk": minor
"@telorun/cli": minor
"@telorun/ide-support": minor
"@telorun/language-server": minor
---

A failed import is reported the same way by `telo check`, by `ctx.runtime.check` and by a run.

- **Breaking for a caller of `ctx.runtime.check` that read `loadError` on an import failure.** The seam now answers with exactly the diagnostics `telo check` reports — built by the same assembler, with the same codes, messages and locations (`line` / `column` set wherever `telo check` locates one) — so a failed import is its coded diagnostic at `imports.<alias>` (`INVALID_IMPORT_SOURCE`, `IMPORT_UNRESOLVED`, `INVALID_IMPORT_TARGET`, `KIND_PREFIX_RESERVED`), and `loadError` is set only when the graph could not be loaded at all (an unreadable entry, a refused partial). It used to stop at the first failed import and return its loader message as `loadError`, and to stop at a parse failure before analysing the rest.
- **A run refused for a failed import carries every import's static diagnostic** under `ERR_INVALID_IMPORT_SOURCE`, `ERR_IMPORT_UNRESOLVED`, `ERR_INVALID_IMPORT_TARGET` or `ERR_KIND_PREFIX_RESERVED` (a loader error carrying a code of its own keeps it), so `telo run` prints the `imports:` line `telo check` prints and a refused child writes `[<CODE>] <message>` for it. The Node kernel used to raise the loader's bare error for every import failure but a reserved prefix. An import of the built-in vocabulary archive is `ERR_INVALID_IMPORT_TARGET` in both kernels (it was `ERR_MANIFEST_VALIDATION_FAILED`). A `Telo.Import` declared in a `with:` scope is loaded, when its scope opens, by the same per-import step the graph walk runs and refused the same way: an unresolvable source is `ERR_IMPORT_UNRESOLVED` and a malformed one `ERR_INVALID_IMPORT_SOURCE` (both were the bare loader error), an application target is `ERR_INVALID_IMPORT_TARGET` in the loader's words (it was `ERR_MANIFEST_VALIDATION_FAILED`), and so is a target with no `Telo.Library` (it was an uncoded error). `@telorun/analyzer` exports that step, `loadImportTarget`, and `importFailureDiagnostics` for it.
- **A failed `Kernel.reconcile()` leaves the kernel as it was.** A reconcile refused while loading (a failed import, a parse failure) used to keep the refused graph, so the next reconcile diffed against it — missing a library edit, or reporting a spurious `restartRequired` after the edit was reverted.
- **Breaking for a consumer of `@telorun/ide-support`'s diagnostic assembly**: `assembleGraphDiagnostics`, `compromisedFiles`, `findPositions` and `resolveRange` moved to `@telorun/analyzer`, which also exports `locateDiagnostic` (a diagnostic's file and range, as every host reports it). `@telorun/ide-support` no longer exports them.
