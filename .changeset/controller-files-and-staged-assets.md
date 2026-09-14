---
"@telorun/sdk": minor
"@telorun/kernel": minor
"@telorun/analyzer": minor
"@telorun/cli": minor
---

Add `ctx.resolveControllerFile(relative)`, which resolves a module-relative reference against the module that declares the resource's controller rather than the module that declared the resource, so a controller can reach its own module's assets. A `sources:` entry may now stage a file an `assets:` pattern selects: it ships in the `assets` layer, publish reads it from its pin, and in a source checkout every staged file at or beneath a resolved reference is brought to its pin (`ERR_MODULE_FILES_UNAVAILABLE` when it cannot be) — for `ctx.resolveModuleFile`, `ctx.resolveControllerFile` and `!include-*` alike. A module whose `sources:` block does not read resolves no module file.

A kernel running from a source checkout now stages a `sources:` file on first use: a missing or stale native file, module file or prebuilt `napi` addon is fetched from its archive under a per-archive lock in the module's `.telo/staging/` and written only once it matches its pin, so a fresh clone runs a manifest with no `telo release stage` step; the kernel prints one line naming the entry and URL when a fetch starts. A module-file reference stages only the module files beneath it (asset-claimed entries and notices), never another platform's native file. An unpinned entry is still refused. A prebuilt controller whose archive cannot be fetched falls through to the next candidate and a stale copy on disk is never opened; an archive not holding the pinned file is `ERR_STAGED_FILE_INVALID`, and any other staging failure (a lock, a write) is the new `ERR_STAGING_FAILED`. The staging sequence moves from the CLI into `@telorun/kernel`, and `telo release stage` runs it under the same lock.
