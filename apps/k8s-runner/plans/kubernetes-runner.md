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
+ log streaming for SSE) is the core deliverable; "reusing the SSE/IO clients"
refers only to the *editor* side.

**Kubernetes API access.** The backend drives the kube-apiserver via the official
**`@kubernetes/client-node`**. In-cluster it uses `loadFromCluster()` — the
projected **ServiceAccount token** + CA cert mounted at
`/var/run/secrets/kubernetes.io/serviceaccount/`, apiserver address from
`KUBERNETES_SERVICE_HOST/PORT`; out-of-cluster dev falls back to `~/.kube/config`.
It touches CoreV1 (Pods, Services), BatchV1 (build Jobs), and NetworkingV1
(Ingress, per-session NetworkPolicy). Log streaming is `readNamespacedPodLog`
with `follow:true` (feeds SSE stdout/stderr); the `/io` PTY is the client's
`Attach` helper over the Pod `attach` subresource; status transitions and
orphan-reap enumeration come from a `Watch`/informer on session Pods. All of it is
gated by the runner's scoped RBAC.

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
is trivially exhausted by one abuser (global capacity, and node disk via the
cache). So the bare runner is deployable standalone only on a *trusted/internal
network*; **public anonymous exposure (the editor.telo.run use case) requires the
control plane — or an equivalent abuse-control front — in front of it.** v1 ships
the runner + the seam, not a publicly-exposable anonymous endpoint.

**Pod model.** Each session is a bare Pod (not Deployment/Job) — these are
ephemeral sandboxes the runner owns end-to-end; it sets `activeDeadlineSeconds`
from the TTL ceiling and reaps on stop/exit/timeout. The Pod runs the same
`telorun/node` image and `telo run` entrypoint as docker-runner, fronted by a
bundle-fetch initContainer and mounting the prebuilt `.telo` cache read-only
(dependencies are materialized out-of-band by a trusted build Job — see
Dependency caching).

**Bundle delivery.** The runner holds the bundle and exposes a fetch URL guarded
by a **per-session unguessable token** (so one session can't read another's
bundle); an `initContainer` pulls it into an `emptyDir` shared with the main
container. Uniform, with no ConfigMap 1MiB size cliff. Because the fetch is a
cluster-internal call to the runner Service, the egress NetworkPolicy must carve
out the runner Service as an explicit allow target (see Sandboxing) — meaning the
runner is a reachable in-cluster endpoint from untrusted pods, which the token
guard and a read-only/short-lived bundle handle mitigate.

**Dependency caching.** Today every run re-fetches all module manifests and
re-runs `npm install` for controllers, even for the same app — wasteful and slow.
The runner fixes this with a **content-addressed `.telo` cache**, but a shared
cache across tenants forces a hard constraint: **its writer must be trusted.** A
naive shared cache written by the untrusted install (its postinstall scripts run
arbitrary code — `npm-loader` runs `npm install`, executing scripts) is a
cross-tenant poisoning channel: a malicious manifest bakes poison into a cache
entry that the next user hashing to the same key warm-mounts and executes. So the
design separates a *trusted* materialization from the *untrusted* run:

- **Key from inputs — fully pinned.** runner-core resolves the manifest graph
  itself (the `Loader.loadGraph` walk — manifests are YAML, no code executes, safe
  in the trusted runner) to discover the full transitive import + controller-PURL
  closure. The key hashes that closure **plus a resolved npm lockfile/integrity
  hash and the `telorun/node` image digest** — not just top-level PURLs, which
  under-specify transitive npm versions (registry patches drift over time) and
  ignore native-ABI changes across runtime upgrades. Only a fully-pinned key makes
  "same key ⟺ same artifact" actually true.
- **Trusted, script-free materialization.** A cache miss is filled by a
  *trusted* build (a per-key build Job, sandboxed and registry-egress-scoped)
  running `npm ci --ignore-scripts` against the pinned lockfile plus the
  manifest-cache write. With scripts disabled and integrity pinned the install is
  deterministic and executes no controller code, so its output is safe to publish
  read-only and share across sessions/users. **Limitation:** controllers that
  require install scripts / native builds aren't served by the shared cache in v1
  (documented gap; future: a verified-output sandboxed build, or a vetted
  allowlist of build-requiring controllers). This **reverses** the earlier
  "install via initContainer for simplicity" decision — that placement is what
  created the poisoning hole.
- **Session pods consume read-only.** The untrusted main container mounts the
  finished `.telo` read-only and only *runs* it; it never writes the cache. (This
  also removes the RW-hostPath-into-untrusted-container surface — only the trusted
  build Job has write access.) **Verify** that `telo run`'s load path is
  read-only-safe against a pre-populated `.telo`: `npm-loader` writes
  `.telo-state.json` and a `.lock` in `.telo/npm` on load, which would `EROFS`
  against a read-only mount. If the runtime path isn't RO-safe, the cache state
  must live in a writable overlay/`emptyDir` while the heavy `node_modules` stays
  read-only.
- **Storage — per-node, with a GC and a PodSecurity caveat.** The cache is a
  per-node inline `hostPath` volume (`type: DirectoryOrCreate`) at
  `<cache-root>/<key>` — *not* a PV (a PV's node affinity would bind the cache to
  one node and cold-start/block pods elsewhere; inline hostPath self-warms each
  node independently). **hostPath is disallowed by the restricted PodSecurity
  Standard**, so the session namespace runs at *baseline* PSS with hostPath
  permitted (a conscious, stated relaxation; all other hardening stays on). The
  cache needs a **size cap + LRU/TTL eviction reaper** (node-disk DoS otherwise —
  untrusted runs would fill the node and evict unrelated workloads). Cost: each
  app builds once *per node*, bounded by node count, not run count.
- **One resolution, not two.** runner-core passes its resolved closure/lockfile
  to the build so the build doesn't independently re-resolve against a possibly
  mutated registry (which would make key ≠ artifact). Note this puts a hard
  registry dependency + resolve latency on session-create.

This caching is a `runner-core` concern (key computation, manifest-graph
resolution, hit/miss, trusted-build orchestration), so the **docker-runner gets
the same fix for free**; only the hostPath/build-Job mechanism is k8s-specific.

**Sandboxing** (untrusted code is the crux; the kernel is left untouched for now,
so containment is purely at the pod boundary):

- Always-on container hardening: non-root, read-only rootfs, drop-all
  capabilities, no service-account token, seccomp `RuntimeDefault`. The one
  deviation from *restricted* PodSecurity is the hostPath cache mount, so the
  session namespace runs at *baseline* PSS (stated relaxation; everything else
  stays restricted-equivalent).
- `RUNNER_RUNTIME_CLASS` — unset by default (stock runc, runs on any cluster);
  operators set `gvisor`/`kata` where available for kernel-level isolation.
- **Egress is not stock-expressible.** Because the trusted build Job moves
  controller installation out of the session pod, the **session pod needs no
  registry egress** — only an allow to the runner Service (bundle fetch) and DNS,
  with cluster-internal, RFC1918, and the metadata endpoint blocked. The
  CIDR/metadata blocks are expressible in vanilla `NetworkPolicy`; the *build
  Job's* registry allow side is **not** — core NetworkPolicy is CIDR-only (no
  FQDN), npm/registry sit behind rotating-IP CDNs, and not every CNI enforces
  NetworkPolicy at all (flannel ignores it). So the registry allowlist requires a
  CNI with FQDN policy (Cilium) or an egress proxy — a stated dependency, not
  "stock k8s". Targets are env-configurable.
- **Pod-to-pod isolation.** Session pods share one namespace, so a NetworkPolicy
  must deny pod-to-pod traffic between sessions (one session must not reach
  another's Service/port).

**Per-session ingress.** When `RUNNER_INGRESS_BASE_DOMAIN` is set, each session
gets a Service + Ingress at `<sessionId>.<base-domain>`, and the resulting URL is
announced through the existing `running`-status `endpoints` (the `RunnerEndpoint`
contract gains a scheme/URL field — a backward-compatible extension shared with
the docker-runner adapter). Ports are exposed on the pod/service only, never on
the node. When unset, the runner is logs-only. **Dependencies (not stock k8s):**
an Ingress controller, **wildcard DNS** for `*.<base-domain>`, and a **wildcard
TLS cert** (anonymous user code is served over HTTPS). The per-session Service +
Ingress carry an **`ownerReference` to the session Pod** so Kubernetes GCs them
automatically when the Pod dies — essential given sub-minute sessions would
otherwise leak ingress objects and churn the controller's reconcile loop.

**Editor side.** A new dedicated **k8s adapter** under
`apps/telo-editor/src/run/adapters/` (registered in `run/registry.ts`),
reusing the SSE/IO clients. Its config is minimal — a base URL — because limits
and image are server-enforced, not user-pickable. Pointed at a bare runner or a
control plane interchangeably.

**Image build & publish.** The runner ships as its own container image, mirroring
docker-runner exactly. A new `apps/k8s-runner/Dockerfile` follows the same
multi-stage shape (`development` → `build` running `pnpm deploy --legacy --prod`
to hoist a self-contained workspace → `node:24-slim` `production`). A new
`k8s-runner` job in `.github/workflows/publish-docker.yml` builds that Dockerfile
(`target: production`) and pushes `telorun/k8s-runner:latest` + `:sha-<short>`
with a `k8s-runner` gha cache scope, alongside the existing `runner` job. The
workflow's `push.paths` trigger gains `apps/k8s-runner/**` and `packages/runner-core/**`
(the shared package both runners build from). The image distributed to *spawned
session Pods* is unchanged — still `telorun/node` running `telo run`; this image
is only the runner service itself.

As part of this work the docker-runner image is renamed `telorun/telo-runner` →
`telorun/docker-runner` so both runners are named after their app directory. The
existing `runner` job tags, `docker-compose.yml`, and the docker-runner README
are updated in the same change.

**Deployment & packaging.** The runner ships as a **Helm chart** at
`apps/k8s-runner/chart/`, the install unit for both Telo Cloud and self-hosters;
its values map onto the env knobs below. Two namespaces:

- **`telo-runner`** — the runner itself: a single-replica **Deployment**
  (`telorun/k8s-runner`), a **Service** (reached by the editor/control plane and
  by session initContainers for bundle fetch; optional **Ingress** for `/v1`), and
  the runner's **ServiceAccount + Role/RoleBinding**.
- **`telo-sessions`** — where session Pods/Services/Ingresses/build-Jobs land,
  labelled *baseline* PodSecurity and carrying the static scaffolding: a
  **`ResourceQuota`** (DoS backstop — caps aggregate CPU/memory/pod-count/
  ephemeral-storage), the default-deny + pod-to-pod-isolation **NetworkPolicies**,
  and any **RuntimeClass** reference.

Split of responsibility: the **chart** provisions this static scaffolding once at
install; the **runner** creates per-session objects at runtime (Pod, Service,
Ingress, build Job, per-session NetworkPolicy with `ownerReference` GC). The
runner's RBAC is scoped to exactly those verbs in `telo-sessions` (plus Pod
attach + log-stream) — its blast radius if compromised is stated and kept minimal.

**Lifecycle.** The session registry is in-memory, so on boot the runner **reaps
orphaned session Pods by label selector** (the k8s equivalent of docker-runner's
`bundle-sweep`), since a restart otherwise orphans every running Pod — this is the
**single-replica** assumption (two replicas would double-manage Pods). Session
Pods get an `ephemeral-storage` limit; together with the cache-eviction reaper
this bounds node-disk and cluster-capacity abuse.

## Decisions

- **Extract `runner-core`; runners are thin backends** — prevents docker/k8s
  drift; rejected straight copy of docker-runner.
- **Same `/v1` contract for k8s-runner** — lets the editor adapter and a future
  control plane treat all runners uniformly.
- **Dumb runner; policy lives in the control plane** — keeps the runner generic
  and self-hostable; Telo Cloud's business logic stays out of the open component.
- **Env limits are hard ceilings, request limits clamp down only** — without a
  control plane the editor hits the runner directly, so a raisable limit would
  void the 50m/100m cap. `min(requested, ceiling)` is the safe invariant.
- **Everything env-configurable** — the bare runner is usable standalone on a
  *trusted/internal network* before any control plane exists. It is **not** safe
  to point at anonymous internet traffic without abuse controls (rate limiting /
  per-IP concurrency), which live in the control plane — a hard precondition for
  the editor.telo.run use case, not an optional add-on.
- **Bare Pod, not Deployment/Job** — ephemeral, runner-owned lifecycle; no
  self-healing wanted for a sandbox.
- **RuntimeClass optional, hardening always-on** — ships on any cluster out of
  the box; gVisor/Kata is an operator upgrade, not a hard dependency.
- **Default-deny egress; registry allow needs a CNI/proxy, not stock k8s** — the
  build Job's controller fetches are the exfil path; vanilla NetworkPolicy is
  CIDR-only and CDN IPs rotate, so the allowlist requires Cilium FQDN or an egress
  proxy (stated dependency). Session pods need no registry egress at all.
- **Content-addressed `.telo` cache materialized by a *trusted* build** — a shared
  cache requires a trusted writer; an untrusted install (postinstall scripts) would
  poison cross-tenant entries. A per-key build Job runs `npm ci --ignore-scripts`
  against a pinned lockfile (deterministic, code-free → safe to share read-only).
  Reverses the initContainer-install idea, which created the hole. Trade-off:
  controllers needing install scripts/native builds aren't cached in v1.
- **Cache key = full pinned closure + lockfile/integrity + image digest** —
  top-level PURLs alone under-specify transitive npm versions and ignore native-ABI
  drift across runtime upgrades; only a fully-pinned key makes "same key ⟺ same
  artifact" true.
- **Per-node inline `hostPath` cache, not a PV — at *baseline* PSS** — a PV's node
  affinity would bind/cold-start pods; inline hostPath self-warms each node. Cost:
  hostPath forces *baseline* (not restricted) PodSecurity, and the cache needs a
  size cap + LRU/TTL reaper (node-disk DoS). Per-node redundancy bounded by node
  count; OCI/object-store is the future multi-node path behind the same key.
- **Session pod consumes `.telo` read-only** — only the trusted build writes the
  cache, removing the RW-hostPath-into-untrusted surface; contingent on verifying
  `telo run`'s load path is RO-safe (npm-loader's `.lock`/`.telo-state.json` writes
  may need a writable overlay).
- **New dedicated k8s editor adapter, not a reused docker adapter** — anonymous
  users must not pick image/limits; config is just the runner URL.
- **Kernel untouched** — containment is at the pod boundary only for now;
  sandboxing inside the kernel is explicitly out of scope.
- **Abstract backend interface (byte-stream + stdin + resize + wait)** — not
  docker's `ReadWriteStream`; the k8s `/io` impl is the Pod `attach` subresource
  over WS/SPDY, the core deliverable, not a one-liner.
- **Single-replica runner + label-selector orphan reap on boot** — the registry is
  in-memory, so a restart orphans Pods; reaping mirrors docker-runner's
  `bundle-sweep`. Scoped RBAC, per-namespace `ResourceQuota`, pod-to-pod
  NetworkPolicy isolation, and `ownerReference` GC of per-session Service/Ingress
  are required, not optional.
- **Bundle fetch over a tokenized URL with a runner-Service egress carve-out** —
  the cluster-internal-block exception is unavoidable; a per-session unguessable
  token prevents cross-session bundle disclosure.
- **Own published image, built like docker-runner** — same multi-stage
  Dockerfile + a sibling `k8s-runner` job in `publish-docker.yml`
  (`telorun/k8s-runner`); keeps the two runners' build/release paths identical
  and adds `packages/runner-core/**` to the image trigger. The docker-runner image is
  renamed `telorun/telo-runner` → `telorun/docker-runner` in the same change so
  both are named after their app directory.
- **Helm chart at `apps/k8s-runner/chart/`; runner in `telo-runner`, sessions in
  `telo-sessions`** — one install unit for Telo Cloud and self-hosters; values map
  to the env knobs. Chart provisions static scaffolding (RBAC, quota, baseline-PSS
  namespace, NetworkPolicies), runner creates per-session objects at runtime.
- **It's a "runner", not an "operator"** — request-driven, ephemeral-session,
  imperative HTTP service; no CRDs, no reconcile loop. "Operator" is reserved for a
  hypothetical future CRD-based declarative production-deploy component, which would
  be separate.

## Configuration surface (env)

- `RUNNER_MAX_CPU` (e.g. `50m`), `RUNNER_MAX_MEMORY` (e.g. `100Mi`),
  `RUNNER_MAX_TTL` (e.g. `1h`) — hard ceilings; also the defaults.
- `RUNNER_MAX_SESSIONS` — global capacity backstop.
- `RUNNER_RUNTIME_CLASS` — optional sandbox RuntimeClass.
- `RUNNER_INGRESS_BASE_DOMAIN` — wildcard base for per-session ingress; unset =
  logs-only. Requires a wildcard-DNS + wildcard-TLS + ingress-controller cluster.
- `RUNNER_CACHE_ROOT` — node path for the per-node `.telo` dependency cache
  (inline hostPath, `DirectoryOrCreate`).
- `RUNNER_CACHE_MAX_BYTES` / `RUNNER_CACHE_TTL` — size cap + eviction window for
  the cache reaper.
- Build-Job registry targets (FQDN allowlist via Cilium or an egress proxy — not
  plain NetworkPolicy).
- Image / pull policy, runner namespace (`telo-runner`), session namespace
  (`telo-sessions`, baseline PSS), and runner ServiceAccount — set as Helm values.

## Out of scope (future)

The Telo Cloud control plane (auth, tiers, environments such as staging/
production, paid limit overrides, per-IP concurrency, rate limiting) is a
separate deliverable. This plan only guarantees the seam it plugs into: a dumb
runner with a hard-ceiling, clamp-down limit contract.

A cluster-wide dependency cache (OCI artifact or object storage, distributed
per-node like image pulls) is the future multi-node scale path for the `.telo`
cache. It slots in behind the same `runner-core` key contract, so the per-node
hostPath cache can be swapped without touching key computation or the
trusted-build flow.
