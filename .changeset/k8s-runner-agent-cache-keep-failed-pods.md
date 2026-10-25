---
"@telorun/k8s-runner": patch
---

The session pod's agent container now gets a writable `TELO_CACHE_DIR` under its scratch `/tmp`, so the kernel's parse, CEL and analysis caches no longer fail with `EACCES` inside the image. `RUNNER_KEEP_FAILED_PODS=true` leaves a session pod that failed to start in place, named in the start error, so it can be inspected with `kubectl describe` and `kubectl logs`.
