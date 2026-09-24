---
"@telorun/cli": patch
"@telorun/analyzer": patch
---

Fixed: `telo release status` and `telo release check` no longer fail with `MODULE_PATH_NOT_FOUND` for a `!module-path` naming a file the module's own `sources:` block stages as a module file (an entry an `assets:` pattern selects, or a source's notice), or a directory such a file lies beneath, when that file is not yet staged on disk. Release commands digest staged files from their pins, so such a file ships from its pin, and a directory claim covers every staged file beneath it as well as what is on disk. `telo publish` and `telo package`, which read staged files from disk, still refuse a path with nothing there (`MODULE_PATH_NOT_FOUND`) and an empty directory (`MODULE_PATH_EMPTY`). The analyzer exports the shared rule (`stagedModuleFiles`, `pathsAtOrBeneath`) that `telo check` applies to the same question.
