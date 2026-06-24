---
"@telorun/cli": patch
---

Honor `--no-cache-write` when fetching the on-demand debug UI for `--inspect`. Previously the bundle was always written into `TELO_CACHE_DIR`, so in the k8s runner — where `/telo-cache` is the baked, read-only deps cache and the workload runs with `--no-cache-write` — the cache write failed (`EROFS` / `ENOENT mkdir '/telo-cache/debug-ui'`) and the inspect UI came up unavailable. Under `--no-cache-write` the fetched bytes are now served in-memory via `DebugServer` and never touch disk.
