---
"@telorun/analyzer": patch
---

Fixed: `telo check` no longer reports `MODULE_PATH_NOT_FOUND` for a `!module-path` naming a file the module's own `sources:` block stages as a module file (an entry an `assets:` pattern selects, or a source's notice), or a directory such a file lies beneath. The kernel stages that file on first use, so in a fresh checkout the check failed a module that runs. A path no entry stages, a staged native file, and any path while the `sources:` block cannot be read are still reported.
