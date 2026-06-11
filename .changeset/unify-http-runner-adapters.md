---
"@telorun/runner-core": minor
"@telorun/docker-runner": minor
"@telorun/k8s-runner": minor
"@telorun/editor": minor
---

Unify the docker and kubernetes runners behind a `/v1/capabilities` discovery
endpoint. Runners advertise their own editable config schema; the editor
collapses the docker-api and k8s adapters into a single capability-driven
http-runner adapter with managed add/edit/remove/switch runners, and preflights
required variables/secrets before a run.
