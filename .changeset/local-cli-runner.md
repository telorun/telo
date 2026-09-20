---
"@telorun/cli": minor
"@telorun/runner-core": minor
"@telorun/k8s-runner": minor
---

Add `telo runner`: the `/v1` runner API served over local processes, so an editor — or any client — can run applications on this machine without Docker.

Each application in a session is a `telo run --watch --inspect` of the running executable, which is what makes the supervisor and the supervised one version by construction. Three things differ from the container backends and each is advertised rather than hidden: there is no PTY (`features.io` is `["streams"]`, and an explicit `io: "tty"` is refused rather than silently downgraded), there is no isolation (the workload inherits this process's environment and privileges), and ports are bound directly on the host instead of published.

**It is a code-execution API with no authentication, so it is closed by default in two directions.** It binds `127.0.0.1` and refuses a non-loopback bind without `--allow-remote`. And it allows **no browser origin** unless one is named with `--allow-origin` (or `RUNNER_CORS_ORIGINS`): every page a user visits can reach `127.0.0.1` from their browser, and a runner answering `Access-Control-Allow-Origin: *` would let one of them start a session. Native clients, which send no `Origin`, are unaffected. Session workspaces hold the user's source, so they are created `0700` under a per-process directory that the next runner reclaims if this one is killed.

The process backend lives in the CLI, beside the substrate it owns, exactly as the docker backend lives in the image that fronts a docker socket. What that required of `@telorun/runner-core` is the contract change below.

**Breaking, for a client that skipped the editor: `SessionConfig` and `ProbeConfig` no longer declare `image` and `pullPolicy`.** They were container vocabulary in the backend-neutral contract, invisible only while every backend ran containers. The session config is now an opaque bag the runner describes through `config.schema` on `/v1/capabilities` and enforces through `validateConfig` — the mechanisms that already existed and already were the authority the editor renders from. `POST /v1/sessions` no longer requires `config` at all. The two halves of a container backend's answer — the schema it advertises and the parser it reads back — moved to `@telorun/runner-core/container`, so the neutral entry point carries no image vocabulary.

Nothing changes for a client of docker-runner or k8s-runner: both still require an image and reject a config they cannot use with `400 invalid_config` naming the field (a probe reports it as `needs-setup` instead of rejecting the request, which is what a probe is for). The k8s gate is now unconditional — it used to exist only when a base-image catalog was configured, so a catalog-less deployment accepted a non-string image and an unknown pull policy, and started a pod on its default image without telling anyone.

Two smaller changes in core: a narrowed origin list is now **enforced by the runner** (`403 origin_not_allowed`) rather than left to the browser's CORS rule, since a client that ignores response headers is not bound by CORS at all; and `buildServer` takes an optional `logStream`, because a runner hosted inside a CLI cannot write its request log to stdout, where that stream is the machine surface.
