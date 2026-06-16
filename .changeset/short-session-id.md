---
"@telorun/runner-core": minor
---

Session ids are now short 12-character base32 strings (e.g. `k7m3qx9r2abc`) instead of 36-character UUIDs. The shorter id keeps `<id>.<domain>` session hostnames and `telo-run-<id>` container/pod names compact while staying DNS- and Kubernetes-name-safe. Generated centrally via `generateSessionId`; ids remain opaque to clients.
