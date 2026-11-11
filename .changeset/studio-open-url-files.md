---
"@telorun/studio": minor
---

Opening an app from a URL copies the files its modules claim with `!module-path`, `!include-text` and `!include-bytes` beside its manifests, so an app that embeds a file (the chat example's `telo-mark.svg`) runs from the copy. A claimed file that cannot be fetched is listed as an error in the import preview, and a binary file, which the workspace cannot store, as a warning.
