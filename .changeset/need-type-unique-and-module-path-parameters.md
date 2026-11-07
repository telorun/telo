---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/cli": minor
---

A `Telo.NeedType` may declare `unique: true`: a module declares at most one need of the type, and a second is `NEED_DUPLICATE` at `telo check` and `ERR_NEED_DUPLICATE` at load, naming both needs. A need's `parameters:` accept `!module-path` at a parameter the type declares a `Telo.HostPath`: it is a module file claim like one on a resource — `telo publish` / `telo package` carry the file, a path naming nothing is `MODULE_PATH_NOT_FOUND` and one naming the other kind of entry than the parameter's `entry` is `HOST_PATH_ENTRY_MISMATCH` (`ERR_HOST_PATH_ENTRY_MISMATCH` at load) — resolved at load against the module declaring the need, so `ctx.resolveNeed` hands over the absolute path, and printed module-root-relative (`"./logo.png"`) by `telo needs report`. Every other tag in `parameters:` (`!cel`, `!interpolate`, `!include-text`, `!ref`), and a `!module-path` at a parameter that is not a host path, is `NEED_PARAMETERS_INVALID`, where an expression used to be judged as the placeholder object it loads as; a `!module-path` there is no longer `MODULE_PATH_OUTSIDE_RESOURCE`.
