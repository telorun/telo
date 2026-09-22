---
"@telorun/sdk": minor
"@telorun/templating": minor
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/cli": minor
"@telorun/studio": minor
"@telorun/ide-support": minor
"telo-vscode": minor
---

Host paths and module paths: a path is anchored by what declares it

`x-telo-type: Telo.HostPath` is a new value type for an absolute path on the machine running the application. In CEL it is a type of its own: extend one with the new `.joinPath('sub/dir')`, which joins with the host's separator (`\` on Windows) and keeps it a host path, and read it as text with `string(path)`; a plain string where a host path is required is a static error. Every value-type brand now converts to its base the same way (`int(ports.http)`). A relative one is refused wherever it is held — `HOST_PATH_RELATIVE` at `telo check`, with a repair to `!module-path`, and `ERR_HOST_PATH_RELATIVE` at creation for a relative path an expression computes — except in an Application `variables:` / `secrets:` entry typed `Telo.HostPath`, whose env value or `default:` is resolved against the working directory at load. That is the directory `.env` is read from, and for a packaged executable started by double-click, the one it sits in.

Nothing else anchors a relative host path, and `telo check` says so where it is written: a relative `default:` at a host-path field of a kind's schema or a library variable is `HOST_PATH_RELATIVE` at the declaring document, and a plain CEL reference feeding a host-path field from a source declared as something else (a `type: string` variable) is `HOST_PATH_UNTYPED_SOURCE` — at the resource field, and where an import supplies a library's host-path variable. A relative literal an import passes to a library's host-path variable, and an expression starting with a relative literal (`'data/' + variables.name`), are `HOST_PATH_RELATIVE` as well. A union field with a constant branch (`":memory:"`) beside a path now reads each value as the branch it names, statically and at runtime.

`!module-path <path>` is a new tag naming a file or directory that ships with the module by its location. The kernel resolves it at resource creation to the absolute path on disk (`ERR_MODULE_PATH_NOT_FOUND` when nothing is there). `telo publish` and `telo package` carry everything beneath a named directory with no `files:` entry and refuse one that is missing or empty (`MODULE_PATH_NOT_FOUND` / `MODULE_PATH_EMPTY`). A missing one in the entry module is also reported by `telo check`, VS Code and Studio: the loader asks the new optional `ManifestSource.exists(base, relative)`, implemented by the Node, VS Code, Tauri and File System Access sources, and records it as `LoadedGraph.modulePathDiagnostics`. A tag on a document that is never instantiated is `MODULE_PATH_OUTSIDE_RESOURCE`, and `DiagnosticFix.tag` gains `module-path`. The Rust templating crate reads the tag and the Rust kernel resolves it.

Studio offers `!module-path` as a path tag wherever its produced `Telo.HostPath` fits the field.
