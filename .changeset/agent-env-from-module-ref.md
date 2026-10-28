---
"@telorun/runner-core": minor
"@telorun/docker-runner": minor
"@telorun/k8s-runner": minor
---

Breaking: `RUNNER_APPS` is retired, and a runner that sets it refuses to boot, naming its replacement. The co-resident agent is configured by `AGENT_*` variables instead: `AGENT_IMAGE` (a container image, as before) or `AGENT_MODULE_REF` (an `oci://` reference or an absolute host path, run as `telo run` on the runner's kernel image and fetched at start), with `AGENT_PORT` required, and `AGENT_ENV`, `AGENT_PULL_POLICY`, `AGENT_TOKEN_ENV`, `AGENT_TITLE` and `AGENT_DESCRIPTION`. The catalog of named apps is gone; the one agent is advertised as `authoring-agent`. The k8s chart's `agent.moduleRef` value renders `AGENT_MODULE_REF`; a host path there is refused, since a pod cannot read the operator's machine.
