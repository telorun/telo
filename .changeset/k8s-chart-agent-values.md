---
"@telorun/k8s-runner": patch
---

Chart (breaking): the `apps:` values block is replaced by a root-level `agent:` object (`image`, `port`, `env`, `pullPolicy`, `tokenEnv`, `title`, `description`) and `agent.secretEnv` (env read from Secret keys) in place of `apps.catalogSecret`. The chart renders it into the runner's `RUNNER_APPS` as the one `authoring-agent` entry.
