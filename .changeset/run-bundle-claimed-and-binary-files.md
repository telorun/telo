---
"@telorun/studio": patch
"@telorun/runner-core": patch
"@telorun/docker-runner": patch
"@telorun/k8s-runner": patch
---

A run started from Studio now ships every file a manifest names with a tag — a `!module-path` file or directory, an `!include-text` / `!include-bytes` file — in the entry module and every local module it imports, as `telo publish` does; before, only `files:` patterns and `include:` partials reached the session, so such an app failed to boot with `MODULE_PATH_NOT_FOUND` / `INCLUDE_FILE_NOT_FOUND`. A file whose bytes are not UTF-8 now travels as base64 (`encoding: base64` on a bundle file and on a watch session's writes) instead of being decoded as text and corrupted; the session route declares the field, and a one-shot run on the docker and k8s runners writes it as its decoded bytes.
