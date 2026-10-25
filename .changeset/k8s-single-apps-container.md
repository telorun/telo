---
"@telorun/k8s-runner": patch
"@telorun/runner-core": patch
---

The Kubernetes runner runs every application of a session in one `apps` container, so adding, removing or re-versioning an app no longer recreates the pod and restarts the workspace and agent. Each app runs on its own telo release binary, downloaded from `RUNNER_TELO_RELEASES_URL` (chart: `session.teloReleasesUrl`) onto the session claim. A session holds at most eight apps (`400 too_many_apps`), the `RUNNER_MAX_*` limits are shared by them, and unreleased builds are refused. `RUNNER_TELO_IMAGE_*` and `RUNNER_TELO_UNRELEASED_IMAGE` no longer apply to k8s. The supervisor gains `--slots <n>` to run several supervisors in one container.
