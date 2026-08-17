---
"@telorun/k8s-runner": minor
---

The session kernel image is baked into the runner image at build time instead of
defaulting to a mutable `telorun/node:latest-slim`, and the chart's `session.image`
now defaults to empty so that baked value wins.

A mutable tag there made a session's kernel whatever was last released,
independently of the runner that was tested with it — so a runner deployed weeks
ago could spawn sessions on a kernel two CLI releases newer or older than its own.
That is how a 0.74.0 kernel ended up running a module published against 0.76.0 and
failing on manifest syntax it had never heard of.

`TELO_SESSION_IMAGE` (build arg) sets `RUNNER_IMAGE`. CI passes it **on the release
path only**, as the CLI version the runner image was built against — so a released
`k8s-runner:<version>` and its session kernel are the same artifact. A dev build
passes nothing and keeps the Dockerfile default `telorun/node:latest-slim`, which is
multi-arch; the per-commit kernel tags are amd64-only, and pinning one behind the
mutable `k8s-runner:latest` would have left arm64 clusters unable to pull a session
image. Lockstep is only meaningful for an immutable runner tag anyway.

Operators who deliberately want sessions on a different kernel than the runner still
set `session.image` (Helm) or `RUNNER_IMAGE` (env), and the base-image picker is
unchanged — the default is always offered in it.
