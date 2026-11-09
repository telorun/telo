---
"@telorun/cli": minor
"@telorun/analyzer": minor
---

`telo release status`, `check` and `apply` take `--carried-by <ref>`: a pending fragment of the same path and content at that ref's merge base with `HEAD`, or written on it since, is dropped from the plan, so a fragment a release branch already carries plans nothing a second time. Without the option nothing is dropped. The changed-files reading of `telo release check` is now the plain `base...HEAD` diff: files of commits contained in a `v*`, `modules-*` or `packages-*` tag are no longer left out.
