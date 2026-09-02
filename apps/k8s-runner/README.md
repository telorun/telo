# @telorun/k8s-runner

HTTP service that runs Telo Applications as sandboxed **Kubernetes Pods**. A
backend over [`@telorun/runner-core`](../../packages/runner-core), sibling to
[`docker-runner`](../docker-runner) — it presents the identical `/v1` session
contract (`/v1/health`, `/v1/capabilities`, `/v1/probe`, `/v1/sessions`,
`/v1/sessions/:id/events` SSE, `/v1/sessions/:id/io` WS) but spawns a Pod per
session instead of a container. On `/v1/capabilities` it advertises `image` /
`pullPolicy` as **`readOnly`** (server-enforced — the runner serves untrusted
code under a hard-ceiling policy), so the editor lets the user edit only the
runner URL.

## ⚠️ Security posture

The runner is a **dumb executor**: no auth, no per-IP concurrency, no rate
limiting — only a global `RUNNER_MAX_SESSIONS` backstop. **Do not expose it
directly to anonymous internet traffic.** Front it with the Telo Cloud control
plane (or an equivalent abuse-control proxy), which resolves identity → tier →
limits and forwards to the runner. Standalone, it is safe only on a
trusted/internal network.

Resource limits are **hard ceilings**: a request may ask for *less* than the
configured cap but never more (`min(requested, ceiling)`). For a bare runner
serving an anonymous tier, the ceiling *is* the policy.

## How it works

Per session the runner resolves the image, creates a Pod (`telo run`), watches it
for status, attaches a PTY over the Pod `attach` subresource for the interactive
`/io` channel, and — when an ingress base domain is configured — creates a
per-session Service + Ingress (`<sessionId>.<base-domain>`) garbage-collected via
an ownerReference to the Pod.

**Every session runs a prebuilt per-app image** — there is no in-pod install
path. On a session-create the runner stages the bundle plus a generated
`Dockerfile` (`FROM <base>`, `ENV TELO_CACHE_DIR=/telo-cache`, `RUN telo install`),
runs a trusted **Kaniko** Job in the `telo-builds` namespace that bakes every
controller and module manifest into `/telo-cache/{manifests,npm}` and pushes the
result, then runs the session pod from that image — so the session never installs
anything on the start path and a slow/unreachable package registry can't stall it.

**The image is keyed on the dependency closure, not the whole bundle** — the
`imports:` set plus any controllers declared by inline `Telo.Definition` docs
(see `extractDependencyKey`). A body-only edit (resource config, CEL) reuses the
existing image; only an import or controller change rebuilds. The per-session
**body is delivered at boot**, not baked: a body-fetch initContainer untars the
staged bundle into a writable `/app` emptyDir, and the session runs `telo run
/app/<entry> --no-cache-write` — reading the baked deps from the read-only
`/telo-cache` and validating in-memory, so `readOnlyRootFilesystem` stays on with
nothing written to the cache. Builds are existence-checked before building and
single-flighted; a build failure surfaces as an actionable error carrying the
build pod's log tail. `RUNNER_IMAGE_REPOSITORY` is therefore **required** — the
runner refuses to start without a registry to build into.

**Coming-up progress** is reported over the `/v1` SSE stream as `progress` events
(`build` → `provision`) while the session is still `starting`. The session is
created with a fast `201` carrying the `streamUrl` **before** the build runs, so
the client connects immediately and sees build + provision progress live; the
backend then runs in the background and a start failure surfaces as a terminal
`failed` status on the stream. The session flips to `running` when the Pod reaches
`Running`.

Sandbox hardening is always on (non-root, read-only rootfs, drop-all caps, no
service-account token, seccomp `RuntimeDefault`); a sandbox RuntimeClass
(gVisor/Kata) is layered on when configured. In the prebuilt path the per-app
image is single-tenant, so install scripts run normally inside the trusted build
(native/postinstall controllers work) with no cross-tenant cache to poison.

## Watch sessions

Everything above describes a **run** session: one pod per Run click, terminal when
the workload exits. `POST /v1/sessions` with `mode: "watch"` asks for something
different — a **workspace that runs continuously**. One pod holds a shared
`/workspace` volume, a `workspace` container serving the editor's file routes, one
`app-<name>` container per application running `telo run --watch`, and optionally
a co-resident `agent` drawn from the `RUNNER_APPS` catalog. An edit then costs a
kernel reload instead of a pod: no schedule, no pull, no build.

Off unless `RUNNER_WATCH_SESSIONS` is set. Run sessions are entirely unaffected.

### The pod

| Container | Image | Present | Writes | Credential |
| --- | --- | --- | --- | --- |
| `workspace` | The kernel image, over a runner-supplied manifest | Always | `/workspace` | None |
| `agent` | Operator catalog image | When `agent` is requested | `/workspace` | Operator env |
| `app-<name>` | The kernel image | One per app | `/workspace`, `/telo-cache/<name>`, scratch | Session-declared env only |

**The env split is the credential boundary.** It used to be structural (two pods)
and is now a code invariant: the operator env goes on `agent` alone, every
`app-<name>` gets the session's declared env and nothing else, and `workspace`
gets neither — it serves files and holds no secrets.

**A shared `fsGroup` is required**, and its absence is the kind of thing that
fails as a confusing "file not found" one reload after a write: every container
reads and writes `/workspace`, so they must share a GID or the agent writes files
the app cannot read.

**The agent is routed like an app port, and reported like one.** Its catalog
entry declares the `port` its image listens on, and the session refuses an agent
without one (`400 agent_port_undeclared`) rather than starting a container
nothing can reach. The pod's containers share one network namespace, so two of
them cannot bind the same port at all — but where an application declares the
agent's port the **manifest wins**: the session starts without the agent and says
so on its stream, rather than refusing to run the user's app over a container
they never asked for and cannot decline. Nothing else is arranged: the pod's containers
share one network namespace, so the port simply joins the session's own Service
and Ingress and answers at `<agentPort>-<sessionId>.<base-domain>`. The `running`
status carries it as an `agent` endpoint beside `endpoints` — separate, because
`endpoints` are the ports the user's applications declared, and an
operator-launched container is not one of them. It is reachable without auth for
as long as the session lives, which is the exposure an app session of the same
image already has.

**Nothing verifies that the agent listens where `port` says.** `port` tells the
runner where to route; what the image actually binds is configured separately
(the authoring agent reads `PORT`, defaulting to 8080). If the two disagree the
runner publishes a port and routes a host with nothing behind it, and the agent
appears to start while every request to it fails — neither backend watches the
agent's port the way both watch an application's. Keep `port` and any `PORT` in
the entry's `env` in agreement.

**The workspace surface is runner infrastructure, not agent functionality.** It is
part of the `/v1` session contract, so the runner owns its manifest and its
routes; the agent is one more writer on the volume beside the app containers,
using its own filesystem tools. It runs the plain kernel image over a manifest the
runner reconciles into a content-addressed ConfigMap — there is no third image to
build, and a runner upgrade that changes the manifest leaves running sessions
mounting the one they booted with.

**Watch sessions never build an image.** The build path exists to put a dependency
closure on disk before boot; a watch session resolves its own into the workspace
volume, which lives as long as the pod, so the download happens once per session
and every later reload resolves from local disk.

**One cache for the whole session.** The runner seeds `telo-workspace.yaml` at
the workspace root when the session starts, and the kernel anchors its `.telo`
cache at the directory holding that marker — so two apps importing the same
module resolve it once between them, and an app in a subdirectory does not get a
cache of its own. The application containers therefore carry no `TELO_CACHE_DIR`:
that variable OUTRANKS the marker, so setting it per app is exactly what would
undo this. Only the `workspace` container keeps an explicit root, because its own
manifest lives outside the workspace and the walk-up would never reach the
marker. A workspace that brings its own marker keeps it — overwriting one with a
real `modules:` list would change what `telo release` discovers.

**Egress moves into the session namespace.** Module fetches used to be scoped to
the build namespace; a watch session resolves them itself, so the session
namespace's NetworkPolicy has to reach module registries as well as the model
provider. Core NetworkPolicy is CIDR-only and registries sit behind rotating-IP
CDNs, so a locked-down operator needs a CNI with FQDN policy or an egress proxy
here — the same stated dependency the build namespace already carries, one
namespace over.

### Two nouns on one stream

*Session status* (`status` events) is `starting` / `running` / `suspended` /
`stopped` / `failed`. *Run outcome* (`run` events) is one per app per reload
generation:

```json
{ "type": "run", "app": "web", "generation": 3, "phase": "started",   "trigger": "watch" }
{ "type": "run", "app": "web", "generation": 3, "phase": "completed", "code": 0, "durationMs": 412 }
{ "type": "run", "app": "worker", "generation": 4, "phase": "failed", "reason": "ERR_MANIFEST_VALIDATION_FAILED" }
```

A one-shot Runnable finishing emits `run` with `phase: "completed"` and leaves
`status: running` — the session is alive and the next edit starts that app's next
generation. `generation` is monotonic per app and starts at 1.

Those events are **projected** from the kernel debug stream, not parsed out of the
terminal: a watch session always runs with `--inspect` on, and `Kernel.Starting` /
`Kernel.Stopped` bracket each generation on one debug connection that survives
reloads. The one thing that stream did not carry is a manifest that fails to load
at all, so the CLI now emits `Kernel.RunFailed` (`{ phase: "load" | "start", code?,
message }`) — a dotted event name inside an existing frame kind, so it obliges no
other runtime.

### Routes

| Route | Purpose |
| --- | --- |
| `GET /v1/sessions/:id/workspace` | Content-hash tree the editor diffs against its own files |
| `POST /v1/sessions/:id/workspace` | Apply a `{ write: [{path, content, encoding?}], delete: [path] }` change set |
| `GET /v1/sessions/:id/workspace/file?path=` | One file's contents |
| `POST /v1/sessions/:id/reload?app=<name>` | Re-run one app with no file change (omit `app` for all) |
| `PUT /v1/sessions/:id/apps` | Change the running app set (checkpoint + pod recreate) |
| `POST /v1/sessions/:id/resume` | Bring a suspended session back under the same id |

### A port set that changes on reload

Adding a `ports:` entry is as ordinary an edit as adding an import, and a
container may bind any port regardless of what the pod spec declares — so without
handling, the app listens and is simply unreachable: no ingress, no error, no
event.

The kernel re-resolves its `ports:` block on every load and says so on the stream
the runner is already reading (`Kernel.PortsResolved`), so nothing re-parses a
manifest on the reload path. The runner patches the Service and the Ingress live
and emits an `endpoints` event; a pod's `containerPort` list is documentation, so
this costs no pod recreate. A port another app in the session already declares
cannot be routed — session hosts carry no app name — and comes back on that same
event as `rejected` rather than being dropped.

It routes the DECLARED set, not what happened to bind. A port the manifest never
declared is not exposed, and "did anything actually bind it" is already answered
per port by the reachability watcher (`checking` → `reachable` / `unreachable`).
Keying on a listening event instead would rest on a per-module convention: a
transport whose kind does not emit one would silently get no routing.

### Reload and the app set

`reload` exists because `--watch` reloads on change, and pressing Run again after a
one-shot app completed is not a change. It touches the named app's entry manifest
through the same path everything else uses, so it needs no signalling into the
container, no shared PID namespace and no `exec` — **RBAC gains only `configmaps:
get, create` and `update` on services/ingresses**, the latter so a reload that
changes an app's declared port set can re-patch its routing. Without that, adding a
`ports:` entry leaves the app bound to a port with no ingress, no error and no
event.

Changing the app set costs a pod recreate because a pod's container list is fixed
at creation. That is the only editing action in the design that costs a pod, and
it reuses suspend/resume rather than adding a second path.

### Suspend and resume

A session is no longer a pod. With no SSE/WS subscriber for
`RUNNER_WATCH_IDLE_SECONDS`, the runner snapshots the workspace, deletes the pod
and keeps the session record — `status: suspended`, which is deliberately **not**
terminal. `POST /v1/sessions/:id/resume` creates a fresh pod seeded from that
checkpoint under the same session id. Aggressive reaping is what makes per-visitor
watch sessions affordable, and the checkpoint is what makes aggressive reaping
safe; they only work as a pair.

**The editor holds the authoritative workspace; the checkpoint is a cache.** The
runner is a single replica with an in-memory registry, so a redeploy, crash or
node move drops every suspended session and `resume` answers `404`. That is by
design and it buys less than it looks: a durable suspended workspace is only
meaningful when there is an identity to reattach it to, and accounts are an
explicit non-goal. A watch session exists because an editor is driving it, that
editor already holds every file and already diffs its own copy against
`GET /workspace`, so a `404` costs one change set. Two consequences, stated rather
than discovered: a suspended session is best-effort, and a watch session with no
editor attached and unsaved agent writes is the one place work can be lost —
bounded by `RUNNER_WORKSPACE_CHECKPOINT_SECONDS`.

**Capacity changes shape.** Concurrency becomes bounded by simultaneous *editors*
rather than simultaneous *runs*; the run-session ceilings were sized for the
opposite assumption, which is why watch has its own.

### `io` — terminal or separated streams

Each app declares `io: "tty"` (default) or `io: "streams"`. The difference is
observable **to the application**, not just to the client: `isatty()` drives
colour, line-versus-block buffering, progress bars and prompts, so a loop that is
always a PTY systematically hides how the app behaves in production.

| | `tty` | `streams` |
| --- | --- | --- |
| Output | One merged stream, as a terminal produces | Separated at the source |
| `/io` resize | Yes | Rejected — meaningless without a PTY |
| `CLICOLOR_FORCE` | Injected | **Not** injected |

Nothing is invented at the transport layer: the Pod `attach` subresource without a
TTY already gives separate stdout and stderr channels. The TTY is what collapses
it. `streams` forces nothing *off* either — with no terminal the colour precedence
already resolves to no colour, and an explicit `NO_COLOR` would sit above an app's
own `color: always` and suppress a decision worth observing.

`GET /v1/sessions/:id/io?app=<name>` attaches to one app's terminal; `?app=` is
required whenever the session runs more than one, since there is no defensible
default among several. Every binary frame is `[seq:4 BE][stream:1][payload]`.

### Ports are unique across the whole session

Session hosts are `<port>-<sessionId>.<base-domain>`, a single label, so two apps
both listening on 3000 would collide with nothing to distinguish them. That is a
`400 port_conflict` at session create rather than an app name added to the host
scheme: the user controls both manifests, and a rejected request is a better
outcome than a URL that silently reaches the wrong app.

## Configuration (env)

| Env | Default | Purpose |
| --- | --- | --- |
| `RUNNER_SELF_URL` | _(required)_ | Runner's in-cluster base URL (bundle fetch) |
| `PORT` | `8062` | HTTP listen port |
| `RUNNER_DISPLAY_NAME` | `Telo Runner` | Display name advertised on `/v1/capabilities` (the editor's runner label) |
| `RUNNER_DESCRIPTION` | `Runs the Telo application in a cloud environment` | Description advertised on `/v1/capabilities` |
| `RUNNER_APPS` | _(unset → no apps)_ | JSON map of operator-predefined apps launchable by name (chart: inline `apps.catalog`, or `apps.catalogSecret` referencing a Secret holding the JSON — use the Secret whenever entries embed secrets in `env`); see the docker-runner README for the entry shape, including the `port` an entry must declare to be usable as a session's co-resident `agent`. App sessions run the catalog image directly as a pod — no on-cluster build |
| `RUNNER_APP_MAX_CPU` | `500m` | CPU ceiling for predefined-app pods (separate from the anonymous-session ceiling) |
| `RUNNER_APP_MAX_MEMORY` | `512Mi` | Memory ceiling for predefined-app pods |
| `RUNNER_APP_MAX_TTL_SECONDS` | `21600` | Wall-clock TTL for predefined-app pods (agent sessions are long-lived) |
| `RUNNER_APP_MAX_EPHEMERAL_STORAGE` | `1Gi` | Ephemeral-storage ceiling for predefined-app pods |
| `RUNNER_SESSION_NAMESPACE` | `telo-sessions` | Namespace for session objects |
| `RUNNER_IMAGE` | _(baked at build: the CLI version for a released runner, `telorun/node:latest-slim` for a dev build)_ | Default base image; always offered in the picker and the fallback when the catalog is unreachable. Leave the chart's `session.image` empty to keep the session kernel in lockstep with the runner |
| `RUNNER_INIT_IMAGE` | `busybox:stable` | Build-context fetch initContainer image (wget + tar) |
| `RUNNER_RUNTIME_CLASS` | _(unset → runc)_ | Sandbox RuntimeClass (gvisor/kata) |
| `SESSION_INGRESS_BASE_DOMAIN` | _(unset → logs-only)_ | Wildcard base for per-session ingress |
| `SESSION_INGRESS_TLS_SECRET` | _(unset → no TLS block)_ | `kubernetes.io/tls` Secret (in `telo-sessions`) the session Ingress presents; must cover `*.<base-domain>`. Set for Cloudflare Full (Strict) / any origin-cert upstream |
| `RUNNER_MAX_CPU` | `50m` | CPU ceiling |
| `RUNNER_MAX_MEMORY` | `100Mi` | Memory ceiling |
| `RUNNER_MAX_TTL_SECONDS` | `3600` | Wall-clock TTL (Pod `activeDeadlineSeconds`) |
| `RUNNER_MAX_EPHEMERAL_STORAGE` | `512Mi` | Per-Pod ephemeral-storage ceiling |
| `RUNNER_MAX_SESSIONS` | `32` | Global session backstop; at capacity the oldest exited session is evicted before a new run is rejected |
| `RUNNER_WATCH_SESSIONS` | `false` | Server-side gate. Watch sessions are never client-requestable when off |
| `RUNNER_WATCH_IDLE_SECONDS` | `300` | No SSE/WS subscriber for this long → suspend |
| `RUNNER_WATCH_MAX_TTL_SECONDS` | `21600` | Pod deadline for a watch session. One deadline covers the agent and the app containers, so it takes the longer ceiling and lets idleness do the real work |
| `RUNNER_WATCH_MAX_SESSIONS` | `8` | Concurrency ceiling for watch sessions, separate from `RUNNER_MAX_SESSIONS` |
| `RUNNER_WATCH_RELOAD_LIMIT` | `30` | Per-session reloads per minute |
| `RUNNER_WATCH_SUSPENDED_TTL_SECONDS` | `86400` | How long a suspended session record is retained before eviction. Deliberately not the pod deadline: that bounds a pod, so on its own nothing would ever evict a suspended record |
| `RUNNER_WORKSPACE_CHECKPOINT_SECONDS` | `30` | How often the runner pulls a whole-tree workspace snapshot |
| `RUNNER_EXIT_TTL_MS` | `14400000` | How long exited sessions stay in the registry (so the editor can re-attach and replay their history after a reload) before eviction |
| `RUNNER_TERMS_FILE` | _(unset)_ | Path to the agreement file (plain text / markdown), read at startup — mount it from a `ConfigMap` (e.g. `/etc/telo/terms.md`). Setting this (or `RUNNER_TERMS_BODY`) enables terms: the runner advertises them on `/v1/capabilities` and rejects `POST /v1/sessions` with `428` unless the client sends `x-telo-accepted-terms` matching the version. An unreadable path fails startup. The public cloud should set this |
| `RUNNER_TERMS_BODY` | _(unset)_ | Inline agreement text, for short notes; ignored when `RUNNER_TERMS_FILE` is set |
| `RUNNER_TERMS_TITLE` | `Usage agreement` | Heading shown above the agreement |
| `RUNNER_TERMS_VERSION` | _(hash of body)_ | Acceptance version; defaults to a content hash so any edit to the body automatically re-prompts every client. Set explicitly only to control material-change vs typo |

### Base-image picker

The runner advertises a menu of base images on `/v1/capabilities`, resolved from
a Docker Hub repo's tags (filtered) and cached. The editor renders it as an
editable `image` dropdown; the chosen image is **re-validated server-side**
against the same list, so a client that skips the editor can't widen the set.
`RUNNER_IMAGE` is always offered and is the fallback when Docker Hub is
unreachable. Disable the catalog to lock `image` to `RUNNER_IMAGE`.

Pinned tags (e.g. `0.30.1-slim`) are immutable. A picked **moving** tag like
`latest-slim` only refreshes when the session's `pullPolicy` is `always`: the
build then pins the per-app image to the base's current digest, so a moved tag
yields a new image and rebuilds (otherwise the cached build — keyed on the tag
string — is reused). Movement detection reads the digest from Docker Hub, so a
base hosted elsewhere (GHCR, a private registry) can't be tracked — `always`
degrades to reusing the cached build for it, same as `missing` / `never`.

| Env | Default | Purpose |
| --- | --- | --- |
| `RUNNER_BASE_IMAGE_CATALOG_ENABLED` | `true` | Resolve + advertise the picker; `false` locks `image` to `RUNNER_IMAGE` |
| `RUNNER_BASE_IMAGE_REPO` | `telorun/node` | `namespace/repository` queried on Docker Hub |
| `RUNNER_BASE_IMAGE_PINNED_ONLY` | `true` | Keep only pinned `MAJOR.MINOR.PATCH[-variant]` tags (drops `latest`, `0`, `0.30`) |
| `RUNNER_BASE_IMAGE_EXCLUDE_SHA` | `true` | Drop commit-hash tags |
| `RUNNER_BASE_IMAGE_EXCLUDE_PRERELEASE` | `true` | Drop semver prereleases (`-rc.1`, `-alpha`); `-slim` / `-rust-*` variants are kept |
| `RUNNER_BASE_IMAGE_INCLUDE` | _(unset)_ | Regex a tag must match (escape hatch) |
| `RUNNER_BASE_IMAGE_EXCLUDE` | _(unset)_ | Regex that drops a matching tag (escape hatch) |
| `RUNNER_BASE_IMAGE_LIMIT` | `20` | Cap on advertised tags (newest first) |
| `RUNNER_BASE_IMAGE_REFRESH_SECONDS` | `3600` | Catalog re-fetch cadence |

### Image build (required)

| Env | Default | Purpose |
| --- | --- | --- |
| `RUNNER_IMAGE_REPOSITORY` | _(required)_ | Registry repo for per-app images; tag = bundle hash |
| `RUNNER_BUILD_NAMESPACE` | `telo-builds` | Namespace the trusted Kaniko build Jobs run in |
| `RUNNER_BUILDER_IMAGE` | `gcr.io/kaniko-project/executor:latest` | Image builder |
| `RUNNER_BUILD_TIMEOUT_SECONDS` | `600` | Build Job deadline / wait budget |
| `RUNNER_REGISTRY_INSECURE` | `false` | Push/pull over HTTP / self-signed |
| `RUNNER_REGISTRY_API_URL` | _(unset → always build)_ | HTTP(S) base for the manifest existence check (authenticated via the push Secret) |
| `RUNNER_REGISTRY_PUSH_SECRET` | _(unset)_ | dockerconfig Secret (in `telo-builds`) Kaniko pushes with; also authenticates the existence check |
| `RUNNER_IMAGE_PULL_SECRET` | _(unset)_ | dockerconfig Secret (in `telo-sessions`) the kubelet pulls per-app images with |

## Deploy (Helm)

The runner **requires a registry to build into** (there is no in-pod install
fallback), so point it at one your cluster's kubelet can pull from:

```bash
helm install telo-runner ./chart \
  --set build.repository=registry.example.com/telo-sessions \
  --set-file registry.dockerconfigjson=./dockerconfig.json \  # private-registry auth
  --set session.runtimeClass=gvisor
```

For a private registry, `registry.dockerconfigjson` creates the dockerconfig
Secret in **both** namespaces (push in `telo-builds`, pull in `telo-sessions`) and
wires `RUNNER_REGISTRY_PUSH_SECRET` + `RUNNER_IMAGE_PULL_SECRET` — the kubelet
needs the pull copy because the per-app image is private. (Or manage the Secrets
yourself and reference them via `build.pushSecretName` / `build.pullSecretName`.)
The push Secret doubles as the credential for the manifest existence check, so
the runner can see an already-built image in a private registry and skip the
rebuild — without it a private registry answers `401` and every run rebuilds.
A no-auth registry needs none of this.

The chart provisions the static scaffolding: the runner Deployment (single
replica — the registry is in-memory and the runner reaps orphaned pods on boot),
Service, scoped RBAC, the `telo-runner` / restricted-PSS `telo-sessions` /
baseline-PSS `telo-builds` namespaces, a `ResourceQuota`, and NetworkPolicies
(session pod-to-pod isolation + the build namespace's registry egress). The
runner creates per-session and per-build objects at runtime.

The optional in-cluster registry (`--set registry.enabled=true --set
build.insecureRegistry=true`) derives `build.repository` for you, but works only
on clusters whose **nodes are configured to trust it** — otherwise an external/
cloud registry is simpler. Installing with neither a `build.repository` nor
`registry.enabled` is rejected at template time.

### Origin TLS (Cloudflare et al.)

To have the per-session Ingress present an origin cert (so an upstream like
Cloudflare in **Full (Strict)** mode validates the origin), give the chart a
`kubernetes.io/tls` Secret in `telo-sessions`. The cert must cover the wildcard
`*.<sessionIngress.baseDomain>` — session hosts are a single label
(`<port>-<sessionId>.<base-domain>`). Two ways:

```bash
# A — reference a Secret you manage in telo-sessions (cert-manager, your own sync)
helm install telo-runner ./chart --set sessionIngress.tls.secretName=telo-origin-tls

# B — let the chart create the Secret from your cert + key
helm install telo-runner ./chart \
  --set-file sessionIngress.tls.cert=origin.pem \
  --set-file sessionIngress.tls.key=origin.key
```

Either wires `SESSION_INGRESS_TLS_SECRET`, and the runner stamps a `spec.tls`
block on every session Ingress. Leave all three empty to skip TLS at the origin
(terminated entirely upstream).

> **Egress notes.** (1) The kubelet pulls session images directly and does **not**
> use cluster DNS, so the in-cluster registry only works where nodes trust it
> (e.g. containerd `registries.conf`). (2) Core NetworkPolicy is CIDR-only and
> cannot express the package-registry FQDN allowlist the build namespace needs —
> use a CNI with FQDN policy (Cilium) or an egress proxy to tighten it.

## Development

```bash
pnpm --filter @telorun/k8s-runner build   # tsc
pnpm --filter @telorun/k8s-runner test    # vitest (limits clamp, tar, bundle token)
```

The Kubernetes backend can't be exercised without a cluster; unit tests cover the
backend-independent logic (limit clamping, the tar writer, bundle tokens).
