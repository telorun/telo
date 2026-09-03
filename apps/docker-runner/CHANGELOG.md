# @telorun/docker-runner

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
