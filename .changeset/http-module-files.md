---
"@telorun/kernel": minor
"@telorun/analyzer": minor
---

A module read from a plain `http(s)://` URL now has its files: a file claimed with `!module-path`, `!include-text` or `!include-bytes` (and `ctx.resolveModuleFile`) is fetched from beside the module's `telo.yaml` on first use and kept beside its cached manifest, or in a scratch directory private to the user when it has none (a pinned import reuses it, an unpinned one fetches it again each run), so `telo https://…/examples/chat/telo.yaml` runs an app that embeds a file instead of failing with `ERR_MODULE_FILES_UNAVAILABLE`. A claim names a file, never a directory, and the fetched file is not verified beyond the manifest's own pin. `telo check` now reports a claimed file the origin does not serve (`INCLUDE_FILE_NOT_FOUND` / `MODULE_PATH_NOT_FOUND`), in the entry and in any module imported by URL, as it does for a local module, and `MODULE_FILE_UNREADABLE` — located at the claim — for one the origin could not answer for.
