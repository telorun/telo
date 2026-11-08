---
"@telorun/sdk": minor
"@telorun/analyzer": minor
"@telorun/kernel": minor
---

A `Telo.HostPath` slot may say what media type its file holds: `x-telo-type: { name: Telo.HostPath, entry: file, mediaType: image/png }`. The vocabulary is data in the value-type entry — `image/png`, `image/jpeg`, `image/gif`, `image/webp` and `application/pdf`, each with the signatures of the file's leading bytes — and a media type with none is `X_TELO_TYPE_ARGUMENT_INVALID`. `telo check` reads the head of a `!module-path` file through its manifest source (the optional `ManifestSource.readHead`, which the Node kernel's file source implements) and refuses one of another type, or a directory, as `HOST_PATH_CONTENT_MISMATCH` at a resource field and at a need parameter, naming the path, the type found (or that none known matched) and the one declared; a variable declared with another `mediaType` read into the field or passed to a library input declaring another is refused the same way, and at a call's `inputs:` as `CEL_TYPE_ARGUMENT_MISMATCH`. Both kernels refuse the same at creation, after the entry check, as `ERR_HOST_PATH_CONTENT_MISMATCH`, and the Node kernel an Application variable at load. An absent path is never refused, and the file's size is not judged.
