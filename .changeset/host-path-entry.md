---
"@telorun/sdk": minor
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/cli": minor
"@telorun/ide-support": minor
"@telorun/language-server": minor
---

A `Telo.HostPath` slot may say what its path names: `x-telo-type: { name: Telo.HostPath, entry: directory }` (or `entry: file`). Omitted means either, and an absent path is never refused. `telo check` refuses a `!module-path` naming the other kind of entry, a variable declared with the other `entry` read into the field, and one an import passes to a library input declaring the other (`HOST_PATH_ENTRY_MISMATCH`); at a call's `inputs:` the mismatch is `CEL_TYPE_ARGUMENT_MISMATCH`, and a token outside `file` / `directory` is `X_TELO_TYPE_ARGUMENT_INVALID`. The kernel refuses an existing path of the other kind when it creates the resource holding it (`ERR_HOST_PATH_ENTRY_MISMATCH`) and one the filesystem will not answer for (`ERR_HOST_PATH_UNREADABLE`), and an Application variable or secret declaring `entry` at load, inside `ERR_MANIFEST_VALIDATION_FAILED`. `!module-path` completion offers only directories at a directory slot. The value-type data gains a parameter flag, `hostEntry`, which both SDK readers accept on a `fromHost` type only. `ManifestSource.exists` is replaced by `entryAt(base, relative)`, answering `file`, `directory` or nothing; the loader stamps what a single-claim tag names on it. `Telo.DurableDirectory.path` declares `entry: directory`. The Rust kernel now refuses both at creation as the Node kernel does — a path of the other kind (`ERR_HOST_PATH_ENTRY_MISMATCH`) and a relative one, literals included since it runs no analysis (`ERR_HOST_PATH_RELATIVE`) — and both kernels answer one set of vectors, `analyzer/host-path-conformance/`.
