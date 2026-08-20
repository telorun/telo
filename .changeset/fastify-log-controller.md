---
"@telorun/runner-core": patch
"@telorun/k8s-runner": patch
---

Move to fastify 5.12, where per-request logging is switched off through the `logController` option instead of the deprecated top-level `disableRequestLogging` (FSTDEP023).
