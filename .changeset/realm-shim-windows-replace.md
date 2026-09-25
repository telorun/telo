---
"@telorun/kernel": patch
---

Parallel kernels sharing one `.telo` cache on Windows no longer fail to load a bundled controller with `ERR_MODULE_NOT_FOUND` for `@telorun/sdk`: replacing a generated realm or sibling-library shim that another process is writing or reading at the same moment is retried, and settles once the file holds the intended content.
