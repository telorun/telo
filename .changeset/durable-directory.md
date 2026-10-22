---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/cli": minor
---

`Telo.DurableDirectory` — a kernel-declared need type for persistent storage on disk. Its field `path` is a `Telo.HostPath`; its parameters are `size` (a whole number followed by `Mi`, `Gi` or `Ti`, default `1Gi`) and `access` (`single-writer`, the default, or `shared`), neither measured nor enforced by the kernel. A host supplies each need through its env name (`TELO_NEED_UPLOADS__PATH`), or sets `TELO_HOST_STATE_DIR` once and every unset one is answered as `<state dir>/needs/<need path>`, created at load.

However a directory is supplied, the kernel checks it names a directory the process can write to and creates it when absent, refusing otherwise with `ERR_NEED_DIRECTORY_UNUSABLE` — before any resource initializes for one read from the environment, when the import initializes for a field-by-field supply, when created for a fulfilment the manifest writes. Under a state directory, an entry under `needs/` no need names (a renamed need or import alias) refuses a load that would create a fresh directory beside it with `ERR_NEED_ORPHANED`, naming both paths, and is otherwise a `NEED_ORPHANED` warning; nothing is moved or deleted. `TELO_HOST_STATE_DIR` is hidden from controllers like a need's env name and is not inherited by an application started with `App.Instance`.

`telo check` and the kernel refuse a `shared` directory forwarded whole to a `single-writer` need, and a smaller `size` forwarded to a larger one (`NEED_FORWARD_INCOMPATIBLE`), and one directory forwarded whole to two or more needs (`NEED_DIRECTORY_FORWARDED_TWICE` / `ERR_NEED_DIRECTORY_FORWARDED_TWICE`). `telo needs report` now lists every need's `parameters` with its type's schema defaults filled in, for every need type.
