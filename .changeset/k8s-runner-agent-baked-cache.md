---
"@telorun/k8s-runner": patch
---

The session pod's agent container no longer sets `TELO_CACHE_DIR`. It pointed the kernel's cache at an empty scratch directory, away from the cache the agent image bakes at install time, which the image now owns as the runtime user so the kernel can write into it at start.
