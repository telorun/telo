---
"@telorun/editor": minor
---

Retire the Tauri-native local Docker runner in favor of a **local runner supervisor**: the desktop editor now runs the published `telorun/docker-runner` image as a local container (pinned to the docker-runner version built from the same commit; `latest` in dev) and talks to it through the standard http-runner adapter, so local runs gain everything the `/v1` contract carries — progress phases, per-port reachability, capabilities, session re-attach, and the authoring agent (`OPENAI_API_KEY` is forwarded from the host environment when present).

Starting the runner is an explicit user action: availability reports can now carry an adapter-provided **action** (`AvailabilityAction`), rendered as a "Start local runner" button — with its consequences spelled out — in the run panel's unavailable banner and the runner settings row; a "Stop local runner" control tears it down. Nothing boots implicitly: not on launch, not on probe, not on Run. On editor quit the runner container and its bundle volume are removed (workload sessions stop with it).

Persisted `tauri-docker` runner instances migrate in place to the new `local-docker` adapter (`image`/`pullPolicy` carry over; the remote-daemon `dockerHost` option is dropped — point a docker-runner at a remote daemon and add it as an HTTP runner instead).
