---
"@telorun/runner-core": minor
"@telorun/k8s-runner": minor
---

Added: per-session workload tokens. A `RUNNER_APPS` catalog entry may declare `tokenEnv`, an environment variable name. For every session started from that entry — an app session (`POST /v1/apps/:name/sessions`) or a watch session's co-resident `agent` — the runner mints a random 32-character token, injects it into that workload's env under `tokenEnv` through the operator-env channel (so an agent's token reaches the agent container and no application container), and reports it as the new `RunnerEndpoint.token` on every endpoint of that workload: `status.agent` for an agent, every `status.endpoints[]` entry for an app session. A suspended session resumes with the same token; a runner restart starts new sessions and so new tokens. A `tokenEnv` the entry's own `env` also sets, or one that is not an environment variable name, is a `RunnerConfigError` at catalog load, and a client-supplied env var of that name is dropped. The k8s runner's chart documents the field in `apps.catalog`.
