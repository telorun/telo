---
"@telorun/cli": minor
---

`telo module versions <ref> --digests` reports each version with the change-detection digest `telo module digest` prints for it, read in one process with bounded concurrency; `--json` writes `[{ version, digest }]`. A version whose digest cannot be read is reported as `{ version, error }` and named on stderr, so one unreadable tag does not hide the others. Without the flag the output is unchanged.
