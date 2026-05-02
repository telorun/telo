---
"@telorun/sql": minor
---

`Sql.Connection` with `driver: sqlite` now auto-creates the parent directory of the `file:` path on init (mirroring `mkdir -p`). Manifests can use paths like `./tmp/chat-history.sqlite` without a separate filesystem-prep step. Skipped for `:memory:` and `file::memory:?…` URIs (no filesystem touch needed) and when the parent resolves to `.` or `/` (already exists).
