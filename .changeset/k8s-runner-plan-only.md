---
"@telorun/k8s-runner": patch
---

Adds `plans/co-resident-agent-watch-sessions.md`. Plan document only — no code,
no manifest, no behaviour, and `plans/` is outside the package's published
`files`, so the release ships identical bytes. Named rather than left as an empty
changeset because the gate counts only an explicit bump as coverage.
