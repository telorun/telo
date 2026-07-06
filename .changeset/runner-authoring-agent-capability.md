---
"@telorun/runner-core": minor
"@telorun/docker-runner": minor
"@telorun/k8s-runner": minor
---

Operator-predefined app catalog: runners advertise launchable applications on `/v1/capabilities` (`apps`) and `POST /v1/sessions` accepts `app: <name>` instead of a bundle — the runner resolves the image and injects the app's operator env server-side, all from the `RUNNER_APPS` JSON config (no app is built in; runners know nothing about any specific application). Replaces the `TELO_SELF_CONTAINED` sentinel; k8s-runner runs app sessions as direct pods (no image build) under separate `RUNNER_APP_MAX_*` ceilings
