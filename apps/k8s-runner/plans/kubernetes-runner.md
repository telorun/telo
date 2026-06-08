# Kubernetes Runner

## Problem

The hosted editor at editor.telo.run needs to run Telo Applications for visitors,
including anonymous ones, without giving them a machine. The existing
`apps/docker-runner` spawns containers on a host Docker daemon and explicitly
assumes a *trusted network, no auth* — unsuitable for untrusted public code over
the internet. We need a runner that executes manifests as Kubernetes Pods,
contains arbitrary user code (manifests can pull npm/cargo controllers, run
`JS.Script`, open sockets), and enforces hard resource caps. It must be a
generic, self-hostable component: Telo Cloud is one operator, other companies
host their own.

## Solution

A new `apps/k8s-runner` service that presents the **same `/v1` HTTP+SSE contract**
as `apps/docker-runner` (`/v1/health`, `/v1/probe`, `/v1/sessions`,
`/v1/sessions/:id`, `/v1/sessions/:id/events` SSE, `/v1/sessions/:id/io` WS),
but creates a Kubernetes **Pod per session** instead of a container.

Because the docker-runner's session machinery is backend-neutral (only its
`src/docker/` is Docker-specific), we first extract a shared **`runner-core`**
package holding the routes, SSE channel, session registry, ring buffers, bundle
handling, and the backstop capacity cap. `docker-runner` and `k8s-runner` become
thin backends over `runner-core`, each implementing a small `start/stop/stream`
backend interface. This is a refactor of working code, chosen over copy-paste
(option b) so the two runners can't drift.

**Runner-side backend & interactive I/O — the real work.** The backend interface
must be defined around *abstract* primitives — a byte-stream out, a stdin writer,
a resize signal, and a wait/exit — **not** docker's `ReadWriteStream` shape, or
the k8s impl gets forced through a Docker-shaped hole. The docker backend serves
the `/io` WS by hijacking a duplex `container.attach`; the k8s equivalent is the
Pod **`attach` subresource over WebSocket/SPDY** with `stdin:true, tty:true`,
plus resize via the API and reconnection handling. This backend (attach lifecycle
+ status streaming for SSE) is the core deliverable; "reusing the SSE/IO clients"
refers only to the *editor* side.

**Kubernetes API access.** The backend drives the kube-apiserver via the official
**`@kubernetes/client-node`**. In-cluster it uses `loadFromCluster()` — the
projected **ServiceAccount token** + CA cert mounted at
`/var/run/secrets/kubernetes.io/serviceaccount/`, apiserver address from
`KUBERNETES_SERVICE_HOST/PORT`; out-of-cluster dev falls back to `~/.kube/config`.
It touches CoreV1 (Pods, Services), BatchV1 (image-build Jobs), and NetworkingV1
(Ingress). Status transitions and orphan-reap enumeration come from a `Watch` on
session Pods; the `/io` PTY is the client's `Attach` helper over the Pod `attach`
subresource. All of it is gated by the runner's scoped RBAC.

**Dumb runner, policy at the edge.** The runner knows nothing about users, tiers,
or plans. Every session is created with limits drawn from env-configured
**hard ceilings**; a request may carry limits but the effective value is
`min(requested, ceiling)` — clamp-down only, never up. With no caller policy the
ceiling itself is the effective limit, so an env-configured ceiling is a complete
limit policy on its own (e.g. 50m/100m/1h for an anonymous-tier runner).
The future **Telo Cloud control plane** is a separate deliverable (not built
here): a policy-injecting proxy that presents the same `/v1` contract to the
editor, resolves identity → tier → limits, enforces per-IP concurrency and rate
limiting, and forwards to a runner whose ceiling covers its top tier. The
editor adapter cannot tell a bare runner from a control plane.

**Hard precondition — not safe on the open internet bare.** The runner's only
self-protection is a global `RUNNER_MAX_SESSIONS` backstop; it has **no per-IP
concurrency or rate limiting** (those live in the control plane). An
unauthenticated pod-spawning API exposed directly to anonymous internet traffic
is trivially exhausted by one abuser. So the bare runner is deployable standalone
only on a *trusted/internal network*; **public anonymous exposure (the
editor.telo.run use case) requires the control plane — or an equivalent
abuse-control front — in front of it.** v1 ships the runner + the seam, not a
publicly-exposable anonymous endpoint.

**Pod model.** Each session is a bare Pod (not Deployment/Job) — these are
ephemeral sandboxes the runner owns end-to-end; it sets `activeDeadlineSeconds`
from the TTL ceiling and reaps on stop/exit/timeout. The Pod runs a **prebuilt
per-app image** (see Image build) whose `telo run` entrypoint finds every
controller and module already on disk — no runtime install, no bundle-fetch
initContainer, no network dependency to reach `Running`.

**Image build — dependencies resolved ahead of the run, on the cluster.** The
naive path (each session pod runs `npm install` for its controllers at boot) is
the central failure mode: a cold, network-dependent install on the start path. A
slow or unreachable npm registry leaves the pod stalled on a controller-load line
until its deadline kills it, surfacing as an opaque "pod failed" with no
actionable cause. The fix is to **prebuild a self-contained container image per
app, on the cluster, before the session pod runs**:

- **Per-app image, content-addressed by the bundle.** The runner derives an image
  tag from `sha256(bundle files + entry path + base image + telo registry)`. Two
  identical bundles map to one image; re-running the same app reuses it. This is
  the docker-runner's existing build-and-run model, moved on-cluster and keyed for
  reuse.
- **Built by a trusted Kaniko Job in its own namespace.** On a session-create the
  runner stages a build context (the bundle plus a generated `Dockerfile`) behind
  the same tokenized fetch URL used for bundles, then creates a **Kaniko** Job in
  `telo-builds`. The Dockerfile is `FROM <base image>`, `COPY . /app`, `RUN telo
  install /app/<entry>` — `telo install` populates `/app/.telo/{manifests,npm}`
  with every module manifest and controller. Kaniko pushes the result to the
  configured registry. The runner waits for the Job, then creates the session pod
  with that image; a build failure surfaces as an actionable `SessionStartError`
  carrying the build pod's log tail.
- **No shared-cache poisoning problem.** Each image is single-tenant (one app's
  bundle), never a cross-tenant shared cache, so controller install scripts can
  run normally inside the trusted build — native/postinstall controllers work,
  with no `--ignore-scripts` restriction and no cross-tenant write surface.
- **Self-contained run, no kernel changes.** At runtime `telo run /app/<entry>`
  anchors the controller install root to the manifest's directory
  (`computeInstallRoot` → `/app/.telo/npm`), finds everything present, and the
  loader's fast path returns from cache **without writing** — so the image layer
  stays read-only under `readOnlyRootFilesystem`. The session pod sets a writable
  `emptyDir` as its working directory (`cwd`), against which the workload's own
  relative paths (e.g. `sqlite:./data.db`) resolve; the manifest is referenced by
  absolute path so `.telo` resolution still points at the baked `/app/.telo`.
- **Existence check + single-flight.** Before building, the runner does a
  best-effort registry manifest HEAD on the tag and skips the build on a hit;
  concurrent identical session-creates share one in-flight build promise.
- **Cold-start latency + a registry dependency.** First run of a new app/version
  pays a build (npm + telo install + push); subsequent runs pay only an image
  pull (kubelet-cached per node). Builds carry a hard dependency on a reachable
  registry, isolated to the `telo-builds` namespace — not the session pod.
- **GC is the registry's.** Per-app images accumulate; retention/eviction is a
  registry concern (tag TTL / GC policy), not a node-disk reaper. Kaniko Jobs
  self-clean via `ttlSecondsAfterFinished`.

**Registry.** The build pushes to and sessions pull from a container registry —
this is a hard dependency: `RUNNER_IMAGE_REPOSITORY` is required and the runner
refuses to start without it (there is no in-pod install fallback). The chart can
ship an optional **in-cluster registry** (a small `registry:2` Deployment +
Service + PVC) so push and pull stay in-cluster, or operators point
`RUNNER_IMAGE_REPOSITORY` at a cloud registry (ECR/GCR/ACR) with a
`kubernetes.io/dockerconfigjson` push/pull Secret. Either way the registry must be
reachable both from build pods (push) and from the node kubelet (pull).

**Bundle / build-context delivery.** The runner holds the bundle and exposes a
fetch URL guarded by a **per-session unguessable token** (so one session can't
read another's bundle); the build Job's initContainer pulls the build context
(bundle + Dockerfile) into an `emptyDir` Kaniko reads. Uniform, with no ConfigMap
1MiB size cliff. Because the fetch is a cluster-internal call to the runner
Service, the `telo-builds` egress policy carves out the runner Service as an
explicit allow target.

**Sandboxing** (untrusted code is the crux; the kernel is left untouched for now,
so containment is purely at the pod boundary):

- Always-on container hardening on session pods: non-root, read-only rootfs,
  drop-all capabilities, no service-account token, seccomp `RuntimeDefault`. With
  dependencies baked into the image (no hostPath cache), session pods satisfy the
  **restricted** PodSecurity Standard with no deviation.
- `RUNNER_RUNTIME_CLASS` — unset by default (stock runc, runs on any cluster);
  operators set `gvisor`/`kata` where available for kernel-level isolation.
- **Workload egress vs. build egress.** The *session pod no longer needs registry
  egress to start* — controllers are baked in. It still needs whatever egress the
  *workload itself* uses (e.g. calling an external API), so its NetworkPolicy
  keeps the broad allow (public internet except RFC1918 + the metadata endpoint)
  plus pod-to-pod isolation. The **build Job's** registry fetches (npm + telo +
  image registry) are the install path, scoped to `telo-builds`; that allow is not
  fully stock-expressible (core NetworkPolicy is CIDR-only, registries sit behind
  rotating-IP CDNs), so a locked-down operator needs a CNI FQDN policy (Cilium) or
  an egress proxy for that namespace — a stated dependency, not "stock k8s".
- **Pod-to-pod isolation.** Session pods share one namespace, so a NetworkPolicy
  denies pod-to-pod traffic between sessions (one session must not reach another's
  Service/port).

**Per-session ingress.** When `RUNNER_INGRESS_BASE_DOMAIN` is set, each session
gets a Service + Ingress at `<sessionId>.<base-domain>`, and the resulting URL is
announced through the existing `running`-status `endpoints`. Ports are exposed on
the pod/service only, never on the node. When unset, the runner is logs-only.
**Dependencies (not stock k8s):** an Ingress controller, **wildcard DNS** for
`*.<base-domain>`, and a **wildcard TLS cert**. The per-session Service + Ingress
carry an **`ownerReference` to the session Pod** so Kubernetes GCs them when the
Pod dies — essential given sub-minute sessions would otherwise leak ingress
objects.

**Editor side.** A dedicated **k8s adapter** under
`apps/telo-editor/src/run/adapters/` (registered in `run/registry.ts`), reusing
the SSE/IO clients. Its config is minimal — a base URL — because limits and image
are server-enforced, not user-pickable. Pointed at a bare runner or a control
plane interchangeably.

**Image build & publish (the runner's own image).** The runner ships as its own
container image, mirroring docker-runner: an `apps/k8s-runner/Dockerfile`
multi-stage build, a `k8s-runner` job in `.github/workflows/publish-docker.yml`
pushing `telorun/k8s-runner:latest` + `:sha-<short>`. The base image distributed
to *session builds* is `telorun/node` (carries the `telo` CLI used by `telo
install` and `telo run`).

**Deployment & packaging.** The runner ships as a **Helm chart** at
`apps/k8s-runner/chart/`, the install unit for both Telo Cloud and self-hosters.
Three namespaces:

- **`telo-runner`** — the runner Deployment (`telorun/k8s-runner`), its Service,
  optional Ingress for `/v1`, and the runner's ServiceAccount + RBAC; optionally
  the in-cluster registry.
- **`telo-sessions`** — session Pods/Services/Ingresses (restricted PodSecurity):
  a `ResourceQuota` DoS backstop, the pod-to-pod-isolation + egress
  NetworkPolicies, any RuntimeClass reference.
- **`telo-builds`** — trusted image-build Jobs (Kaniko needs a writable rootfs and
  registry egress, so this namespace runs at *baseline* PSS). The runner's RBAC to
  create/watch Jobs and read build logs is scoped here.

Split of responsibility: the **chart** provisions this static scaffolding once at
install; the **runner** creates per-session/-build objects at runtime (Pod,
Service, Ingress, build Job). The runner's RBAC is scoped to exactly those verbs
— its blast radius if compromised is stated and kept minimal.

**Lifecycle.** The session registry is in-memory, so on boot the runner **reaps
orphaned session Pods by label selector**, since a restart otherwise orphans every
running Pod — this is the **single-replica** assumption (two replicas would
double-manage Pods). Session Pods get an `ephemeral-storage` limit.

## Decisions

- **Extract `runner-core`; runners are thin backends** — prevents docker/k8s
  drift; rejected a straight copy of docker-runner.
- **Same `/v1` contract for k8s-runner** — lets the editor adapter and a future
  control plane treat all runners uniformly.
- **Dumb runner; policy lives in the control plane** — keeps the runner generic
  and self-hostable; Telo Cloud's business logic stays out of the open component.
- **Env limits are hard ceilings, request limits clamp down only** —
  `min(requested, ceiling)` is the safe invariant for a directly-exposed runner.
- **Everything env-configurable; not safe bare on anonymous internet** — usable
  standalone on a trusted network; public exposure needs the control plane's abuse
  controls.
- **Bare Pod, not Deployment/Job** — ephemeral, runner-owned lifecycle; no
  self-healing wanted for a sandbox.
- **RuntimeClass optional, hardening always-on** — ships on any cluster; gVisor/
  Kata is an operator upgrade, not a hard dependency.
- **Prebuilt per-app image, built on-cluster — not in-pod install** — moving
  controller resolution off the session start path is the fix for the cold/
  network-dependent install hang. The image is the unit of caching and reuse.
- **Per-app image, not a shared dependency cache** — single-tenant images sidestep
  the cross-tenant cache-poisoning problem entirely, so install scripts run
  normally inside the trusted build and native/postinstall controllers work. No
  `--ignore-scripts`, no read-only-shared-cache surface, no hostPath, and session
  pods stay at *restricted* PodSecurity.
- **Image tag = sha256(bundle + entry + base image + telo registry)** — content
  addressing gives reuse across identical re-runs; a coarse-but-deterministic key
  (the bundle itself, not a resolved lockfile) is enough since each image is
  single-tenant and self-describing. Transitive npm drift is bounded inside one
  image build, not shared across tenants.
- **Self-contained run, no kernel changes** — `telo run` anchors the install root
  to the manifest dir, so a baked `/app/.telo` is found with no override; the
  loader's read path is cache-only (no writes) so the image layer stays read-only.
  A writable `emptyDir` working directory carries the workload's own relative-path
  writes; the manifest is referenced absolutely so `.telo` still resolves to
  `/app/.telo`.
- **A registry is mandatory; no in-pod fallback** — `RUNNER_IMAGE_REPOSITORY` is
  required and the runner refuses to start without it. Use the optional in-cluster
  registry (push + pull stay in-cluster) or a cloud registry with a dockerconfig
  Secret. Removing the fallback keeps one code path and one failure mode, and stops
  a misconfigured deploy from silently regressing to the slow/fragile in-pod
  install this whole design exists to eliminate.
- **Build runs in its own `telo-builds` namespace at baseline PSS** — Kaniko needs
  a writable rootfs and registry egress; isolating it keeps the privileged builder
  away from both untrusted sessions and the runner control plane.
- **Registry GC, not a node reaper** — per-app image retention is a registry policy
  (tag TTL/GC); Kaniko Jobs self-clean via `ttlSecondsAfterFinished`.
- **New dedicated k8s editor adapter, not a reused docker adapter** — anonymous
  users must not pick image/limits; config is just the runner URL.
- **Kernel untouched** — containment is at the pod boundary only for now.
- **Abstract backend interface (byte-stream + stdin + resize + wait)** — not
  docker's `ReadWriteStream`; the k8s `/io` impl is the Pod `attach` subresource.
- **Single-replica runner + label-selector orphan reap on boot** — the registry is
  in-memory, so a restart orphans Pods; scoped RBAC, per-namespace `ResourceQuota`,
  pod-to-pod NetworkPolicy isolation, and `ownerReference` GC are required.
- **Bundle / build-context fetch over a tokenized URL** — a per-session unguessable
  token prevents cross-session disclosure; the build Job fetches the context the
  same way.
- **It's a "runner", not an "operator"** — request-driven, ephemeral-session,
  imperative HTTP service; no CRDs, no reconcile loop.

## Configuration surface (env)

- `RUNNER_MAX_CPU`, `RUNNER_MAX_MEMORY`, `RUNNER_MAX_TTL_SECONDS`,
  `RUNNER_MAX_EPHEMERAL_STORAGE` — hard ceilings; also the defaults.
- `RUNNER_MAX_SESSIONS` — global capacity backstop.
- `RUNNER_RUNTIME_CLASS` — optional sandbox RuntimeClass.
- `RUNNER_INGRESS_BASE_DOMAIN` / `RUNNER_INGRESS_CLASS` — per-session ingress;
  unset = logs-only.
- `RUNNER_IMAGE` — base image for session builds (carries the `telo` CLI).
- `RUNNER_IMAGE_REPOSITORY` — **required** registry repo for per-app images (e.g.
  `registry.telo-runner.svc:5000/telo-sessions`); the runner refuses to start
  without it.
- `RUNNER_BUILD_NAMESPACE` (default `telo-builds`), `RUNNER_BUILDER_IMAGE`
  (default Kaniko), `RUNNER_BUILD_TIMEOUT_SECONDS`.
- `RUNNER_REGISTRY_INSECURE` — Kaniko push/pull over HTTP/self-signed (in-cluster
  registry).
- `RUNNER_REGISTRY_API_URL` — HTTP(S) base for the manifest existence check
  (skip-build-on-hit); unset = always build.
- `RUNNER_REGISTRY_PUSH_SECRET` — dockerconfig Secret name (cloud registry auth).
- `TELO_REGISTRY_URL` — telo module registry used by `telo install` at build time.
- `RUNNER_INIT_IMAGE` — small image (wget + tar) for the build-context fetch
  initContainer.
- Namespaces (`telo-runner`, `telo-sessions`, `telo-builds`) and the runner
  ServiceAccount — Helm values.

## Out of scope (future)

The Telo Cloud control plane (auth, tiers, environments, paid limit overrides,
per-IP concurrency, rate limiting) is a separate deliverable. This plan only
guarantees the seam it plugs into.

A cross-cluster image cache / pull-through mirror and registry GC automation are
operator concerns layered on the registry, behind the same content-addressed tag
contract — the per-app image scheme is unaffected.
