---
"@telorun/templating": minor
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/cli": minor
"@telorun/ide-support": minor
---

A file an `!include-text` / `!include-bytes` names is now checked at load, like a `!module-path`: a missing one is `INCLUDE_FILE_NOT_FOUND` in `telo check` and every editor. Both checks now cover every module the entry reaches through a filesystem-path import (`source: ./lib`), not only the entry module, since such a module is never published and so never verified on its own. Registry imports are still left to their publish.

`telo run` and `telo install` refuse the load on either finding (`ERR_MANIFEST_VALIDATION_FAILED`), before any resource is created, rather than failing when the resource holding the tag is created.

Both findings name the absolute path checked and, when one entry of that directory is a plausible typo of the missing name, offer it as a fix (`Did you mean './primr.md'?`); when the directory itself is missing they say so instead.

`telo install` now exits 1 when its analysis pass fails, printing the kernel's diagnostics and an error count; it used to warn and succeed, so an image whose manifest could not boot built green.

API: `LoadedGraph.modulePathDiagnostics` is renamed `moduleFileDiagnostics`, `EngineFileClaim` gains a required `notFoundCode` — the code an engine's missing claim is reported under — and `ManifestSource` gains optional `locate` and `listDirectory`, implemented by `LocalFileSource`.
