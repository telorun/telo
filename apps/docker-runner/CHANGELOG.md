# @telorun/docker-runner

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
