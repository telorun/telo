# @telorun/docker-runner

## 0.15.1

### Patch Changes

- Updated dependencies [3df9817]
  - @telorun/runner-core@0.23.0

## 0.15.0

### Minor Changes

- ad18a4f: Breaking: `RUNNER_APPS` is retired, and a runner that sets it refuses to boot, naming its replacement. The co-resident agent is configured by `AGENT_*` variables instead: `AGENT_IMAGE` (a container image, as before) or `AGENT_MODULE_REF` (an `oci://` reference or an absolute host path, run as `telo run` on the runner's kernel image and fetched at start), with `AGENT_PORT` required, and `AGENT_ENV`, `AGENT_PULL_POLICY`, `AGENT_TOKEN_ENV`, `AGENT_TITLE` and `AGENT_DESCRIPTION`. The catalog of named apps is gone; the one agent is advertised as `authoring-agent`. The k8s chart's `agent.moduleRef` value renders `AGENT_MODULE_REF`; a host path there is refused, since a pod cannot read the operator's machine.

### Patch Changes

- Updated dependencies [ad18a4f]
  - @telorun/runner-core@0.22.0

## 0.14.1

### Patch Changes

- Updated dependencies [635b289]
  - @telorun/runner-core@0.21.1

## 0.14.0

### Minor Changes

- 3a59a93: The docker runner serves the durable workspace session (breaking). A session's containers — `workspace`, one idle `app-<name>` per application and an optional `agent` — are named `telo-run-<id>-<role>` and labelled `telo.run/session-id=<id>` and `telo.run/role`, over the session's own directory on the bundle volume: `workspace/` at `/workspace` and, for the agent, `agent/` at `/var/lib/telo-agent-state` with `TELO_HOST_STATE_DIR` pointing there. Suspend removes the containers and keeps the directory; deleting the session or retention removes both. Every app container runs the session supervisor, which the runner writes at boot from its image (`/opt/telo-runner/supervisor`) to `.supervisor/<digest>/` on the bundle volume and mounts read-only at `/opt/telo-runner`: no TTY, no stdin and no session env — only `TELO_SUPERVISOR_LISTEN` (`0.0.0.0:<9330 + position>`) and a per-container `TELO_SUPERVISOR_TOKEN`; each app's supervisor port and debug port (`9230 + position`) are reserved, refused `400 port_conflict` (or `rejected` on reload). A container that ends, or a supervisor that restarted, fails the session naming the container. At boot the runner adopts each running session's containers by label — reading every supervisor token and the agent's token back from container inspect, reconnecting, and reporting live runs as `running` — suspends a session whose containers are gone, stale or of another supervisor protocol generation (resume rebuilds them), and its orphan sweep removes containers of sessions not running here and directories the store does not know. The runner now refuses to boot on a daemon older than Docker 26 (Engine API 1.45) instead of advertising `features.watch: false`. One-shot run sessions, catalog app sessions, the bundle upload and the attach path are gone. The image gains a static musl session supervisor, built per architecture, in its `development` stage too.

  App supervisors are driven through runner-core's `SupervisedApp`, and the test engine's supervisors are runner-core's `FakeSupervisor`; a supervisor that never answers is now named by its full container name (`container 'telo-run-<id>-app-<name>'`), as every other docker message names it.

- 3a59a93: Runners gain a durable session store and renamed session settings. `RUNNER_SESSION_STORE` selects `sqlite` (default, Node's built-in SQLite in `sessions.sqlite` under `RUNNER_STATE_DIR`) or `postgres` (`RUNNER_SESSION_STORE_URL`); it keeps each session's owner, workspace name, agent, app set, config, status and times, never env or tokens, with one session per owner and workspace, plus the DPoP `jti`s seen, under a versioned schema whose migrations carry records forward. The k8s and docker runners open it at boot and refuse to start with SQLite and no `RUNNER_STATE_DIR`. Session settings are renamed: `RUNNER_WATCH_MAX_SESSIONS` → `RUNNER_MAX_SESSIONS` (default 8, running sessions), `RUNNER_WATCH_IDLE_SECONDS` → `RUNNER_SESSION_IDLE_SECONDS`, `RUNNER_WATCH_MAX_TTL_SECONDS` → `RUNNER_SESSION_MAX_RUNNING_SECONDS`, `RUNNER_WATCH_SUSPENDED_TTL_SECONDS` → `RUNNER_SESSION_RETENTION_SECONDS` (default 30 days), `RUNNER_WATCH_RELOAD_LIMIT` → `RUNNER_SESSION_RELOAD_LIMIT`; `RUNNER_WATCH_SESSIONS` (every session is now a workspace session, so there is nothing to switch on), `RUNNER_WORKSPACE_CHECKPOINT_SECONDS`, `RUNNER_EXIT_TTL_MS`, `RUNNER_MAX_TTL_SECONDS` and `RUNNER_APP_MAX_TTL_SECONDS` are removed, and a runner started with any of them set refuses to boot, naming the replacement. The k8s runner reads `RUNNER_SESSION_STORAGE_SIZE` (default `5Gi`) and `RUNNER_SESSION_STORAGE_CLASS`, and its chart's `watch.*` values become `sessions.idleSeconds` / `maxRunningSeconds` / `retentionSeconds` / `reloadLimit`, with `runner.maxSessions` defaulting to 8 and `limits.maxTtlSeconds` gone.

### Patch Changes

- Updated dependencies [3a59a93]
- Updated dependencies [3a59a93]
  - @telorun/runner-core@0.21.0

## 0.13.0

### Minor Changes

- adf4eae: `telo run` at a terminal asks for the application inputs nothing supplies instead of failing. When the only reason a root Application cannot load is that `variables:` / `secrets:` / `ports:` entries or the required fields of its needs have no value, the CLI asks for each one on stderr (a secret or sensitive need field without echo), the kernel decodes and validates each answer exactly as it would the same text in the environment, re-asks one it refuses with its own sentence, and the run starts. Answers are the fifth and last source — after a value supplied by name, the command line, `env:` and `default:` — and are never written to the process environment, `ctx.env` or a started child's environment; a need field's answer goes only into that need. Once accepted, the CLI offers to save them (default no): secrets to the sensitive env file, everything else to the other, as `telo env template --write` places them. A watch session keeps its answers across reloads.

  It asks only when stdin and stderr are both terminals and `--no-input` (a new `telo run` option) is not given. Without that, the refusal is unchanged (`ERR_MANIFEST_VALIDATION_FAILED`, `ERR_NEED_UNMET`, `ERR_NEED_PARTIALLY_SUPPLIED`) and adds a hint naming the missing variables; `Kernel.RunFailed` carries them as `unresolved`. The kernel's `load()` takes the asking side as an `inputResolver` option. Every runner backend now starts applications with `--no-input`, and the oldest telo a runner supervises moves to the release carrying it.

### Patch Changes

- Updated dependencies [adf4eae]
  - @telorun/runner-core@0.20.0

## 0.12.2

### Patch Changes

- cc1a84e: A run started from Studio now ships every file a manifest names with a tag — a `!module-path` file or directory, an `!include-text` / `!include-bytes` file — in the entry module and every local module it imports, as `telo publish` does; before, only `files:` patterns and `include:` partials reached the session, so such an app failed to boot with `MODULE_PATH_NOT_FOUND` / `INCLUDE_FILE_NOT_FOUND`. A file whose bytes are not UTF-8 now travels as base64 (`encoding: base64` on a bundle file and on a watch session's writes) instead of being decoded as text and corrupted; the session route declares the field, and a one-shot run on the docker and k8s runners writes it as its decoded bytes.
- Updated dependencies [cc1a84e]
  - @telorun/runner-core@0.19.1

## 0.12.1

### Patch Changes

- Updated dependencies [ae999ff]
  - @telorun/runner-core@0.19.0

## 0.12.0

### Minor Changes

- f72827b: Runners serve each session a container engine of its own, so a test that starts the database it needs runs in a session exactly as it runs locally. With `RUNNER_SESSION_CONTAINERS=true` (default off; chart `session.containers.enabled`) every session gets `TELO_HOST_CONTAINER_ENGINE_URL` (`<RUNNER_INTERNAL_URL>/v1/sessions/<id>/engine`) and `TELO_HOST_CONTAINER_ENGINE_TOKEN`, a token minted for that session; `RUNNER_INTERNAL_URL` is required when the setting is on, and a runner whose backend cannot run containers refuses to boot with it. The engine answers the Docker Engine API 1.41 requests `Docker.Engine` sends and refuses every other one: a missing token is 401 and another session's 403; a create may carry only `Image`, `Cmd`, `Entrypoint`, `Env`, `User`, `ExposedPorts`, `Labels` and `HostConfig.PortBindings` as one `127.0.0.1` binding with an empty `HostPort` per exposed port, anything else being a 400 naming the field path; every container is labelled `run.telo.session=<id>`; a session holds at most `RUNNER_SESSION_CONTAINERS_MAX` (default 4) containers, a create beyond it being 429; inspect, logs, delete and list see only the session's own containers. Nothing is published on a host: inspect answers each requested binding with the address the session reaches the container at. A session's containers are removed when it stops, suspends, reaches its deadline, is deleted or changes its app set, and when the runner shuts down. The docker runner runs them as siblings on `RUNNER_CHILD_NETWORK` and removes every container labelled with a session at boot; the k8s runner runs them as pods under the session namespace's `restricted` Pod Security standard (a `User` that is not a numeric non-root `uid[:gid]` is a 400), with resources from `session.containers.resources` (`RUNNER_SESSION_CONTAINERS_RESOURCES`), owned by the session's pod and reachable only from that session through two per-session NetworkPolicies, deleted when the session ends; the chart's Role gains `networkpolicies` when the setting is on. A pod the Pod Security standard refuses is now reported as that refusal rather than as an unexplained 403. A k8s run session's body-fetch init container now declares the session's resources, so the chart's default resource quota no longer refuses every run session pod.

### Patch Changes

- Updated dependencies [f72827b]
  - @telorun/runner-core@0.18.0

## 0.11.0

### Minor Changes

- 3fe9d3d: **The telo version a module is edited against is the version it runs on.** A session request may name, per application, the telo release it runs on (`telo` on each entry of `apps`, or on the request for a single-app session), and a runner advertising `features.teloVersions` runs exactly that version — never a substitute. What can be known without fetching anything is refused before a session exists: `400 telo_version_unavailable` carries `{ app, version, reason }`; a version sent to a runner that does not advertise the feature is `400 telo_version_unsupported`; text that is not a release version, or a session where only some apps name one, is `400 invalid_telo_version`. Fetching the version — an image pull, a release download — happens inside the session's start, with progress on its stream, and a fetch that fails is that session's failed start carrying the reason.

  - **docker-runner and k8s-runner** run that application's container on `<RUNNER_TELO_IMAGE_REPOSITORY>:<version>-<RUNNER_TELO_IMAGE_VARIANT>` (default `telorun/node:<version>-slim`; chart `session.teloImages`). Which versions may run is the image source's own rule on both; the k8s base-image catalog is the menu `config.image` is picked from and gates nothing else. An unreleased build identity (`X+unreleased`) has no published image: it runs on `RUNNER_TELO_UNRELEASED_IMAGE` where the operator set one and is refused, naming that variable, otherwise. The runner's own `workspace` container never follows an application's version — it stays on the operator's kernel image (`RUNNER_IMAGE`, new on docker-runner). `config.image` and `config.pullPolicy` are **deprecated**: a client naming no version still sends them and gets the old behaviour, the advertised schema marks both `deprecated: true` and requires neither, and a request naming a version beside either is `400 invalid_config`. How a version's image is pulled is the operator's — `RUNNER_PULL_POLICY` (`missing` | `always` | `never`, default `missing`; chart `session.teloImages.pullPolicy`), which also governs the runner's own workspace container. A failed start's status now carries the daemon's own message beside the stage.
  - **`telo runner`** runs its own version as itself and any other as that release's standalone binary for the platform — downloaded while the session starts, verified against the release's `checksums.txt`, cached per version. A cached binary is rehashed against the digest recorded when it was written, which detects a damaged file (the digest sits beside it, so this is not tamper protection). Another build's unreleased identity is refused up front; a failed download names its cause: no release or no binary for the platform, the HTTP status, a missing or non-matching checksum, no writable cache directory.
  - **The runtime says which version it is.** `Kernel.Starting` carries `{ telo }` (`X`, or `X+unreleased` for a build made while `X` is pending; the kernel's own generated `TELO_RUNTIME_VERSION`), and the runner passes it on as `telo` on that generation's `run` `started` event. The runner compares nothing.
  - **Studio** sends the version the language session reports for the module being run (`LanguageRouter.statusOf(uri)`, new in `@telorun/language-host`), shows a runner's refusal in the run dock with the runner's own reason, shows each application's reported version beside its generation, and warns — without stopping the run — when the runtime reports a different version than was asked for, or when the module has moved to another version since the run started. A module with no engine cannot be run until its version is resolved. The runner settings form leaves out every property its schema marks `deprecated`.

  `RunnerBackend` gains the optional `supplyTelo(version, config)`, `BackendAppSpec` carries `telo`, and `ServerDeps.validateConfig` is now a `ConfigGate`, told whether the request names a version.

  **The telo version picker no longer says whether a version's engine is cached** (`describeVersionMark` in `@telorun/language-host`, so in Studio and the VS Code extension alike): it changes nothing a reader would choose by, and "cached" is not a word every reader of that menu knows.

  **An engine built before its release is shown as `X (local)`**, where it read `X (unreleased build)` — in the status label, the version picker and every sentence built from them (`describeEngineVersion`).

  `@telorun/language-host` gains `describeAcceptance(mark)` and an `acceptance: false` option on `describeVersionMark`, for a host that marks acceptance with an icon rather than in the row's text, as Studio's menu now does.

  **Also in this change, and not version alignment:**

  - **A run's files sit in the session where the editor holds them, relative to the workspace root** (Studio's run bundle). An application at `<root>/apps/todo/telo.yaml` is now `apps/todo/telo.yaml` in the session workspace — `entryRelativePath` included — where a single-app run used to be rooted at the application's own directory. The agent's sync writes the editor's whole tree into the same volume relative to that root, and the two layouts disagreeing deleted a running app's files on the first agent turn. A relative path an app takes from an env value now resolves against the workspace root rather than the app's directory; `!module-path` is unaffected.
  - **Deleting an application in Studio stops its running session and drops its runs**, and a save ends the session of an application that has vanished some other way, instead of failing every save with `Entry module not found`.
  - **docker-runner's watch session passes telo's options before the manifest path.** They came after it, where every token is the application's, so an application declaring no arguments refused `--watch`, `--inspect` and `--no-open` at load.
  - **Replacing a docker watch session's app set pulls the new images before removing the running containers**, so a pull that fails leaves the session as it was.
  - **Studio's agent panel opens as a draft when no agent is reachable**, creating the conversation on the agent a send then launches — the first send no longer fails with `ERR_CONVERSATION_NOT_FOUND` — and draws no summary card for a turn that changed no file, ran nothing and was not reverted.
  - **Studio's telo version menu** lists the ten newest minor releases with each one's other versions nested, puts a row's description under its title, marks acceptance with an icon, and its label reads `Telo X` with `(auto)` when Auto chose the version.
  - The capability document gains `config.supersededByTelo` — the config properties a request leaves out once it names a version — and a release older than `MIN_SUPERVISABLE_TELO` (0.95.0, the oldest verified by execution) is refused before a session exists.

### Patch Changes

- Updated dependencies [3fe9d3d]
  - @telorun/runner-core@0.17.0

## 0.10.9

### Patch Changes

- Updated dependencies [4641afc]
  - @telorun/runner-core@0.16.0

## 0.10.8

### Patch Changes

- @telorun/runner-core@0.15.1

## 0.10.7

### Patch Changes

- Updated dependencies [d6ccba0]
  - @telorun/runner-core@0.15.0

## 0.10.6

### Patch Changes

- Updated dependencies [40a5d50]
  - @telorun/runner-core@0.14.1

## 0.10.5

### Patch Changes

- Updated dependencies [5e89ea5]
  - @telorun/runner-core@0.14.0

## 0.10.4

### Patch Changes

- Updated dependencies [e16b5ba]
  - @telorun/runner-core@0.13.0

## 0.10.3

### Patch Changes

- Updated dependencies [4054830]
  - @telorun/runner-core@0.12.0

## 0.10.2

### Patch Changes

- Updated dependencies [8dc6e35]
  - @telorun/runner-core@0.11.0

## 0.10.1

### Patch Changes

- Updated dependencies [f94d89b]
  - @telorun/runner-core@0.10.0

## 0.10.0

### Minor Changes

- d5b8228: Watch sessions: a session can now be a workspace that runs continuously instead
  of one run. One pod holds a shared `/workspace` volume, a `workspace` container
  serving the editor's file routes, one container per application under `telo run
--watch`, and optionally a co-resident agent from the operator's app catalog — so
  an edit costs a kernel reload rather than a pod. Off unless
  `RUNNER_WATCH_SESSIONS` is set; run sessions are unchanged.

  Session status and run outcome become two nouns on one stream. `status` is the
  session's (`starting`/`running`/`suspended`/`stopped`/`failed`), while a new `run`
  event carries one application's generation — so a one-shot Runnable finishing
  leaves the session alive and the next edit starts the next generation. `run`
  events are projected from the kernel debug stream rather than parsed out of a
  terminal, and the CLI now emits `Kernel.RunFailed` for the one case that stream
  did not carry: a manifest that fails to load at all.

  Breaking, and the ripple is the reason the version moves rather than the size of
  it: `RunnerFeatures.io` becomes a list of attach modes; `progress`, `debug`,
  `reachability` and the byte channel are qualified by application (`/io` takes
  `?app=`, and every binary frame gains a stream tag); and the `stdout` / `stderr`
  `RunEvent` variants are deleted — nothing ever emitted them, so they were a
  contract in shape only. Workload output travels the byte channel, as it always
  did in practice.

  `@telorun/debug-wire` gains no code — its README now writes down the four kernel
  events a HOST derives behaviour from (`Kernel.Starting`, `Kernel.Stopped`,
  `Kernel.RunFailed`, `Kernel.PortsResolved`) and the requirement that a stream
  with a replay buffer carry a monotonic `id:` and honour `Last-Event-ID`. The
  dotted event vocabulary is otherwise open; these four are the exception because a
  kernel that omits them leaves a runner with no run outcomes and no way to
  re-route a port, so a second runtime needs them written down.

  The CLI also honours `CLICOLOR_FORCE` for Node's colour libraries, bridging it
  onto `FORCE_COLOR` when that is not already set — one variable now reaches a
  Rust, Go or Node workload alike, and `FORCE_COLOR=0` beside `CLICOLOR_FORCE=1`
  keeps its meaning.

### Patch Changes

- Updated dependencies [d5b8228]
  - @telorun/runner-core@0.9.0

## 0.9.2

### Patch Changes

- Updated dependencies [c7fdbd9]
  - @telorun/runner-core@0.8.2

## 0.9.1

### Patch Changes

- @telorun/runner-core@0.8.1

## 0.9.0

### Minor Changes

- 73ed5ba: Predefined app sessions get their own creation door: `POST /v1/apps/:name/sessions` (`{ env?, ports?, inspect? }`; `404 unknown_app`; same terms gate) replaces the `app` field on `POST /v1/sessions`, whose body schema is strict again (`bundle` + `config` required). Created sessions live in the shared `/v1/sessions` collection (status / DELETE / events / io unchanged)

### Patch Changes

- Updated dependencies [73ed5ba]
  - @telorun/runner-core@0.8.0

## 0.8.0

### Minor Changes

- 721a241: Load `.env` / `.env.local` (dotenv-flow) from the runner package directory at
  startup, so operator secrets like `OPENAI_API_KEY` (injected into app sessions
  from the `RUNNER_APPS` catalog) can live in a file instead of being threaded
  through the container's environment. Existing environment variables always take
  precedence over file values.
- 721a241: Operator-predefined app catalog: runners advertise launchable applications on `/v1/capabilities` (`apps`) and `POST /v1/sessions` accepts `app: <name>` instead of a bundle — the runner resolves the image and injects the app's operator env server-side, all from the `RUNNER_APPS` JSON config (no app is built in; runners know nothing about any specific application). Replaces the `TELO_SELF_CONTAINED` sentinel; k8s-runner runs app sessions as direct pods (no image build) under separate `RUNNER_APP_MAX_*` ceilings

### Patch Changes

- Updated dependencies [721a241]
  - @telorun/runner-core@0.7.0

## 0.7.0

### Minor Changes

- 897c0b9: Surface session port reachability on the endpoint badge instead of the log stream.

  After a session goes running, the runner (`watchReachability` in
  `@telorun/runner-core`, used by the k8s and docker backends) probes each declared
  tcp port and emits a structured `reachability` `RunEvent` per port — `checking`,
  then `reachable`, or `unreachable` after a 30s timeout (flipping back to
  `reachable` if it recovers). The editor renders this on each endpoint link in the
  debug panel: a spinner while checking, a green icon when reachable, a red icon
  when unreachable — turning the loopback-bind / wrong-port failure (previously an
  opaque downstream 502, or a late log line) into live status on the URL itself.

  The badge reflects reachability from the runner to the workload (pod network for
  k8s, published port / container for docker) — a proxy for the common loopback-bind
  failure, not end-to-end health of the public link, and a startup signal rather
  than continuous monitoring (a port that comes up then dies keeps its green icon).

### Patch Changes

- Updated dependencies [897c0b9]
  - @telorun/runner-core@0.6.0

## 0.6.4

### Patch Changes

- @telorun/runner-core@0.5.2

## 0.6.3

### Patch Changes

- @telorun/runner-core@0.5.1

## 0.6.2

### Patch Changes

- Updated dependencies [bc2eeff]
  - @telorun/runner-core@0.5.0

## 0.6.1

### Patch Changes

- Updated dependencies [2558e41]
  - @telorun/runner-core@0.4.0

## 0.6.0

### Minor Changes

- 8133912: Add operator-defined, server-enforced usage terms. A runner advertises `terms` on `/v1/capabilities` (sourced from `RUNNER_TERMS_FILE` or inline `RUNNER_TERMS_BODY`, with the version defaulting to a content hash) and rejects `POST /v1/sessions` with `428 terms_required` unless the client sends the `x-telo-accepted-terms` header matching the current version. runner-core gains `loadTermsFromEnv`, the `RunnerTerms` type, the `ACCEPTED_TERMS_HEADER` constant, and the `terms` capability field. docker-runner reads terms from the environment (off by default); k8s-runner wires them through the Helm chart via a terms ConfigMap.

### Patch Changes

- Updated dependencies [8133912]
- Updated dependencies [8133912]
  - @telorun/runner-core@0.3.0

## 0.5.1

### Patch Changes

- @telorun/runner-core@0.2.1

## 0.5.0

### Minor Changes

- e6e8d88: Unify the docker and kubernetes runners behind a `/v1/capabilities` discovery
  endpoint. Runners advertise their own editable config schema; the editor
  collapses the docker-api and k8s adapters into a single capability-driven
  http-runner adapter with managed add/edit/remove/switch runners, and preflights
  required variables/secrets before a run.

### Patch Changes

- Updated dependencies [e6e8d88]
  - @telorun/runner-core@0.2.0

## 0.4.0

### Minor Changes

- 3dc20d0: Add a Kubernetes runner. Extract backend-neutral `@telorun/runner-core` from docker-runner (shared `/v1` contract, routes, registry, SSE, ring buffers) behind a `RunnerBackend` seam; docker-runner becomes a thin backend over it with no behaviour change. Add `@telorun/k8s-runner`, a `KubernetesBackend` that runs Telo apps as sandboxed Pods (attach-based PTY, hard-ceiling limit clamping, tokenized bundle delivery, per-session ingress, orphan reaping) plus a Helm chart (RBAC, quota, NetworkPolicy) and a CI image job. Add a k8s editor `RunAdapter` via a shared `createHttpRunnerAdapter` factory. Rename the docker image `telorun/telo-runner` → `telorun/docker-runner`.

### Patch Changes

- Updated dependencies [3dc20d0]
  - @telorun/runner-core@0.1.0

## 0.3.0

### Minor Changes

- 7c092be: Live PTY console for the editor's run view (xterm.js + WebSocket).

  - Containers spawn with `Tty: true` + `OpenStdin: true` and a hijacked attach duplex; PTY bytes flow through a single per-session byte ring buffer instead of demuxed stdout/stderr events.
  - New WebSocket route `GET /v1/sessions/:id/io` carries raw bytes both directions plus `{type:"resize",cols,rows}` control frames. `?lastSeq=<n>` resumes from the byte buffer with a `gap` diagnostic when the runner's tail evicted older bytes.
  - The upgrade handler runs an explicit Origin allowlist check before completing the handshake — `@fastify/cors` does not intercept WebSocket upgrades, so this is a defense-in-depth requirement, not a convenience.
  - Status events on `GET /v1/sessions/:id/events` are unchanged; the SSE path now never carries `stdout` / `stderr` event payloads.

  The matching browser editor (`apps/telo-editor`) consumes the new channel via xterm.js. The Tauri build of the editor runs the same xterm host against `docker run -it` directly through Tauri channels and resize commands.

## 0.2.0

### Minor Changes

- 2900b1c: Added port exposure to the Run feature. The Deployment view has an "Exposed ports" editor next to "Environment variables"; both the in-process Tauri Docker adapter and the remote `@telorun/docker-runner` HTTP service publish the configured ports (`-p port:port/protocol` / Docker API `PortBindings`) when a session starts. The Run view header shows one clickable `host:port` chip per exposed port; the host is resolved from `DOCKER_HOST` (Tauri adapter) or from the runner's base URL (HTTP adapter). `RunStatus.running` now carries an optional `endpoints` array describing where the container is reachable.
