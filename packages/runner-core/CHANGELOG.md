# @telorun/runner-core

## 0.12.0

### Minor Changes

- 4054830: k8s-runner no longer builds a per-app image. A run session runs the plain kernel
  image, takes its body over the existing bundle initContainer, and resolves its
  own module closure into a `/telo-cache` emptyDir at boot — the shape a watch
  session already had. The on-cluster Kaniko path, the `telo-builds` namespace and
  everything that fed them are gone.

  **Breaking, and it needs a `helm upgrade` to clear.** `RUNNER_IMAGE_REPOSITORY`
  is no longer read and is no longer required (the runner used to refuse to start
  without it), along with `RUNNER_BUILD_NAMESPACE`, `RUNNER_BUILDER_IMAGE`,
  `RUNNER_BUILD_TIMEOUT_SECONDS`, `RUNNER_REGISTRY_INSECURE`,
  `RUNNER_REGISTRY_API_URL` and `RUNNER_REGISTRY_PUSH_SECRET`.
  `RUNNER_IMAGE_PULL_SECRET` stays — it is now the kubelet's credential for the
  kernel image and any operator catalog image in a private registry, and the chart
  takes it from `session.imagePullSecret`. The chart drops its whole `build:` and
  `registry:` blocks (including the optional in-cluster `registry:2`), the
  `telo-builds` namespace and its Role/RoleBinding, and the build-egress
  NetworkPolicy; an upgrade removes those objects, and a `telo-builds` deleted by
  hand no longer breaks anything. `pullPolicy` now means the Pod's own
  `imagePullPolicy` rather than base-image-freshness for a rebuild.

  `RunPhase` keeps `build`, though nothing in this repo emits it any more: it is
  the vocabulary a _backend_ reports in, and a client is still talking to whatever
  runner is on the other end of the stream. `extractDependencyKey` /
  `DependencyKey` and `resolveTagDigest` are removed from `@telorun/runner-core` —
  the build was their only consumer.

  **The cost is start latency**: a run session's cache dies with its pod, so it
  re-downloads its closure on every start, where the build used to put it on disk
  ahead of boot. A watch session pays it once per pod and is the shape to reach for
  when that matters.

  **Run-session ceilings move with the work**: 50m / 100Mi / 512Mi described a pod
  that only RAN a prebuilt image, with the closure in image layers, which are not
  charged to ephemeral-storage. The pod now downloads, unpacks and resolves the
  closure into an emptyDir, which is — so those numbers meant an OOMKill on memory
  and an eviction on storage for an ordinary session. `RUNNER_MAX_CPU` /
  `RUNNER_MAX_MEMORY` / `RUNNER_MAX_EPHEMERAL_STORAGE` now default to 500m / 512Mi
  / 1Gi, the tier the watch path already ran this same workload under. **The
  chart's `resourceQuota` moves with them**: its old 4 CPU / 8Gi was exactly 32
  pods at the old ceilings, so leaving it would have capped concurrency at four —
  as a 403 the client sees — while `runner.maxSessions` still said 32. It is now
  32 x the per-pod ceiling, and the arithmetic is written down beside it.

## 0.11.0

### Minor Changes

- 8dc6e35: Remove the Telo HTTP registry. Modules resolve over `oci://` and direct `https://` URLs only; the bare `<namespace>/<name>@<version>` ref form and the `registry.telo.run` origin are gone.

  **Breaking.** A manifest whose `imports:` names a bare ref no longer resolves — rewrite it to the module's `oci://` ref. `--registry-url` (run / check / install / upgrade / migrate / module), `--registry` (publish), `TELO_REGISTRY_URL` and `TELO_REGISTRY_TOKEN` are removed, as is `Kernel`'s `registryUrl` option; `defaultTransports` / `defaultTransportRegistry` / `defaultSources` take no argument. `RegistryTransport` becomes `HttpTransport` — it keeps direct `https://` module URLs and the `.telo/manifests/url/…` cache subtree, and enumerates no versions. `RegistrySource`, `parseModuleRef` and `isRegistryRef` are removed from `@telorun/analyzer`, and `withRefVersion` now accepts only `oci://` refs. The `registry/<host>/…` manifest-cache subtree is no longer written or read. `SessionConfig.registryUrl` leaves the runner `/v1` contract, `sessionConfigSchema` loses its `registryUrl` option, and the k8s chart drops `build.teloRegistryUrl` (which also changes every per-app image tag, since the registry URL was a digest input).

## 0.10.0

### Minor Changes

- f94d89b: A session's co-resident `agent` is now **reachable**, so an editor can talk to
  one instead of launching an agent session of its own.

  The pod half already worked: the agent container mounted the shared volume, took
  the operator env and nothing else, and wrote the tree the app containers watch.
  But no backend published its port and no route reached it, so an agent could be
  asked for and could edit files while nothing outside the pod could ask it to.

  **The port is the operator's to declare.** A `RUNNER_APPS` entry gains `port` —
  the tcp port its image listens on — with deliberately **no default**: the catalog
  is operator configuration and the runner has no built-in knowledge of any
  specific app, so defaulting to 8080 would be exactly that knowledge. Requesting
  an agent whose entry declares none is `400 agent_port_undeclared`, naming the
  setting to add, rather than a container started where nothing can reach it. The
  port is unique across the whole session like an app's (`400 port_conflict`),
  because session hosts carry no container name.

  **`RunStatus.running` gains an `agent` endpoint**, beside `endpoints` rather than
  inside it: `endpoints` are the ports the user's applications declared, and an
  operator-launched container is not one of them. An ENDPOINT rather than a URL
  string, because a runner publishing to the host knows the port and not the
  hostname the client reached it by — the same reason an app's endpoint has an
  empty `host` for the client to fill.

  On kubernetes nothing is arranged beyond declaring it: the pod's containers share
  one network namespace, so the port joins the session's own Service and Ingress
  and answers at `<agentPort>-<sessionId>.<base-domain>`. A reload that declares
  that port for an app is rejected with the agent named as the reason.

  ***

  **A docker watch session's workspace is now `/workspace`**, the path kubernetes
  already uses, instead of `/srv/<sessionId>/workspace`.

  The application containers and the agent mount only that session's own
  `workspace` subdirectory of the shared volume. Three things follow, and the
  third is why the change had to happen:

  - A manifest is `/workspace/telo.yaml` on both backends, and no session id
    reaches any path a workload sees.
  - One session's containers can no longer read another session's files on disk.
    The workspace API is still name-addressable with no auth, so the runner is
    still not the multi-tenant one — but the disk half of that exposure is gone
    for watch sessions.
  - Nothing is mounted over a directory an operator's catalog image may already be
    using. Mounting the volume whole at `/srv` covered up the authoring agent's own
    installation, which is why a **co-resident agent could never start on docker**.

  The runner's own `workspace` container keeps the whole-volume bind, because its
  manifest and its module cache sit beside the workspace it serves — and that same
  siblinghood is what keeps both out of the user's file tree now that the mount is
  scoped.

  **This needs Docker Engine API 1.45 (Docker 26) or newer.** An older daemon
  ignores the subpath and mounts the volume whole at the target — every session's
  files in every container, at a path that looks correct — so the runner probes the
  daemon at boot and advertises `features.watch: false` when it is too old rather
  than degrading into that silently. Run sessions are unaffected and keep their
  whole-volume `/srv` bind.

## 0.9.0

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
  - @telorun/debug-wire@0.4.1

## 0.8.2

### Patch Changes

- c7fdbd9: Move to fastify 5.12, where per-request logging is switched off through the `logController` option instead of the deprecated top-level `disableRequestLogging` (FSTDEP023).

## 0.8.1

### Patch Changes

- Updated dependencies [c1fef72]
  - @telorun/debug-wire@0.4.0

## 0.8.0

### Minor Changes

- 73ed5ba: Predefined app sessions get their own creation door: `POST /v1/apps/:name/sessions` (`{ env?, ports?, inspect? }`; `404 unknown_app`; same terms gate) replaces the `app` field on `POST /v1/sessions`, whose body schema is strict again (`bundle` + `config` required). Created sessions live in the shared `/v1/sessions` collection (status / DELETE / events / io unchanged)

## 0.7.0

### Minor Changes

- 721a241: Operator-predefined app catalog: runners advertise launchable applications on `/v1/capabilities` (`apps`) and `POST /v1/sessions` accepts `app: <name>` instead of a bundle — the runner resolves the image and injects the app's operator env server-side, all from the `RUNNER_APPS` JSON config (no app is built in; runners know nothing about any specific application). Replaces the `TELO_SELF_CONTAINED` sentinel; k8s-runner runs app sessions as direct pods (no image build) under separate `RUNNER_APP_MAX_*` ceilings

## 0.6.0

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

## 0.5.2

### Patch Changes

- Updated dependencies [a125804]
  - @telorun/debug-wire@0.3.0

## 0.5.1

### Patch Changes

- Updated dependencies [a8c99ab]
  - @telorun/debug-wire@0.2.0

## 0.5.0

### Minor Changes

- bc2eeff: Session ids are now short 12-character base32 strings (e.g. `k7m3qx9r2abc`) instead of 36-character UUIDs. The shorter id keeps `<id>.<domain>` session hostnames and `telo-run-<id>` container/pod names compact while staying DNS- and Kubernetes-name-safe. Generated centrally via `generateSessionId`; ids remain opaque to clients.

## 0.4.0

### Minor Changes

- 2558e41: k8s-runner: add a base-image picker resolved from a filtered Docker Hub tag catalog and validated server-side, and make `pullPolicy` a live base-image freshness control — `always` digest-pins the build so a moved moving-tag (e.g. `latest-slim`) rebuilds. Adds a generic `BaseImageCatalog` + `resolveTagDigest` and a `validateConfig` server hook to runner-core.

## 0.3.0

### Minor Changes

- 8133912: Retain exited sessions long enough for the editor to re-attach and replay a run's console + inspection history after a page reload. The exit-eviction TTL default goes from 5 minutes to 4 hours, the max retained sessions default from 8 to 32, and at capacity the registry now evicts the oldest _terminal_ session before rejecting a new run (live sessions are never evicted), so a long TTL never blocks a new run.
- 8133912: Add operator-defined, server-enforced usage terms. A runner advertises `terms` on `/v1/capabilities` (sourced from `RUNNER_TERMS_FILE` or inline `RUNNER_TERMS_BODY`, with the version defaulting to a content hash) and rejects `POST /v1/sessions` with `428 terms_required` unless the client sends the `x-telo-accepted-terms` header matching the current version. runner-core gains `loadTermsFromEnv`, the `RunnerTerms` type, the `ACCEPTED_TERMS_HEADER` constant, and the `terms` capability field. docker-runner reads terms from the environment (off by default); k8s-runner wires them through the Helm chart via a terms ConfigMap.

## 0.2.1

### Patch Changes

- Updated dependencies [d59e847]
  - @telorun/debug-wire@0.1.0

## 0.2.0

### Minor Changes

- e6e8d88: Unify the docker and kubernetes runners behind a `/v1/capabilities` discovery
  endpoint. Runners advertise their own editable config schema; the editor
  collapses the docker-api and k8s adapters into a single capability-driven
  http-runner adapter with managed add/edit/remove/switch runners, and preflights
  required variables/secrets before a run.

## 0.1.0

### Minor Changes

- 3dc20d0: Add a Kubernetes runner. Extract backend-neutral `@telorun/runner-core` from docker-runner (shared `/v1` contract, routes, registry, SSE, ring buffers) behind a `RunnerBackend` seam; docker-runner becomes a thin backend over it with no behaviour change. Add `@telorun/k8s-runner`, a `KubernetesBackend` that runs Telo apps as sandboxed Pods (attach-based PTY, hard-ceiling limit clamping, tokenized bundle delivery, per-session ingress, orphan reaping) plus a Helm chart (RBAC, quota, NetworkPolicy) and a CI image job. Add a k8s editor `RunAdapter` via a shared `createHttpRunnerAdapter` factory. Rename the docker image `telorun/telo-runner` → `telorun/docker-runner`.
