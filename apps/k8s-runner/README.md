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

The runner is a **dumb executor** beyond session ownership (a resume secret,
or a DPoP-bound identity when `RUNNER_IDENTITY_AUDIENCE` /
`RUNNER_IDENTITY_ISSUERS` are set): no per-IP concurrency, no rate limiting —
only a global `RUNNER_MAX_SESSIONS` backstop on running sessions. **Do not expose it
directly to anonymous internet traffic.** Front it with the Telo Cloud control
plane (or an equivalent abuse-control proxy), which resolves identity → tier →
limits and forwards to the runner. Standalone, it is safe only on a
trusted/internal network.

Resource limits are **hard ceilings**: a request may ask for *less* than the
configured cap but never more (`min(requested, ceiling)`). For a bare runner
serving an anonymous tier, the ceiling *is* the policy.

## How it works

**A session is a workspace.** Its record lives in the runner's session store and
its files live on a **PersistentVolumeClaim of its own**; its pod is the part that
comes and goes. One pod holds a `workspace` container serving the editor's file
routes, one idle `app-<name>` container per application, and optionally a
co-resident `agent` drawn from the `RUNNER_APPS` catalog. **Nothing runs until
Run**: `POST /v1/sessions/:id/apps/:app/run` is a process start inside a container
that already exists, under `telo run --watch`, so an edit costs a kernel reload
rather than a pod. When a routing base domain is configured the runner also
creates a per-session Service plus routing objects (an Ingress, or one HTTPRoute
per port) at `<port>-<sessionId>.<base-domain>`, owned by the pod.

**Coming-up progress** is reported over the `/v1` SSE stream as `progress` events
(`provision` → `boot`) while the session is `starting`; the session is `running`
once the pod is up, the workspace answers and every app's supervisor has said
hello, and each app then reports `ready`. A start failure is a `failed` status on
the stream, its storage kept, and `resume` retries.

Sandbox hardening is always on (non-root, read-only rootfs on every runner-owned
container, drop-all caps, no service-account token, seccomp `RuntimeDefault`); a
sandbox RuntimeClass (gVisor/Kata) is layered on when configured. The runner
builds nothing and needs no image registry of its own.

**A Kubernetes API rejection reaches the client as its status and `reason`, never
as the exception.** The API's error carries the full HTTP dump — the raw `Status`
body naming the runner's ServiceAccount, the audit id, every response header — so
the client is told the operation, the HTTP code and the one-word reason
(`Forbidden`, `NotFound`), plus who can fix a `403`; the raw exception rides along
as the error's `cause` and lands in the runner's log.

### The pod

| Container | Image | Runs | Mounts | Credential |
| --- | --- | --- | --- | --- |
| `supervisor` (init) | The runner's own (`RUNNER_SUPERVISOR_IMAGE`) | Copies the session supervisor into an `emptyDir`, creates the claim's `workspace/` and `agent/` | The `emptyDir`, the claim's root | None |
| `workspace` | `RUNNER_IMAGE`, over a runner-supplied manifest | `telo run` of the workspace application | `workspace/` at `/workspace` | None |
| `app-<name>` | The app's telo version (`RUNNER_TELO_IMAGE_*`), else the session's picked image or `RUNNER_IMAGE` | `/opt/telo-runner/supervisor`, idle until Run | `workspace/` at `/workspace`, the supervisor read-only at `/opt/telo-runner` | Its own supervisor token |
| `agent` | Operator catalog image | The image's own entrypoint | `workspace/` at `/workspace`, `agent/` at `/var/lib/telo-agent-state` | Operator env |

**No session env is in the pod spec.** An app container carries
`TELO_SUPERVISOR_LISTEN=0.0.0.0:<9330 + position>` and `TELO_SUPERVISOR_TOKEN` (one
random token per container, minted when the pod is created — the pod spec is
where a restarted runner reads it back), the runner's public-address templates,
`HOME` and nothing else: no `TELO_ENTRY`, no `TELO_INSPECT_ADDR`, no
`CLICOLOR_FORCE`, no shell, no TTY and no stdin. A Run's env travels to the
supervisor with the Run and lives only in the process it starts; the supervisor
removes its own two variables before starting anything. **The env split is the
credential boundary**: the operator env goes on `agent` alone and `workspace` gets
neither.

**Each app's supervisor and kernel debug ports are reserved**: `9330 + position`
and `9230 + position` in the app set, because every container of a pod shares one
network namespace. An app declaring one is refused (`400 port_conflict` on a
create or `PUT …/apps`, `rejected` on a reload's `endpoints` event), naming what
binds it. The runner reaches both over the pod IP; neither is published.

**A shared `fsGroup` is required**: every container reads and writes `/workspace`,
so they must share a GID or the agent writes files an app cannot read.

**The agent is routed like an app port, and reported like one.** Its catalog
entry declares the `port` its image listens on, and the session refuses an agent
without one (`400 agent_port_undeclared`). Where an application declares the
agent's port the **manifest wins** on a create: the session starts without the
agent and says so on its stream. The port joins the session's Service and routing
objects and answers at `<agentPort>-<sessionId>.<base-domain>`; the `running`
status carries it as an `agent` endpoint beside `endpoints`. **Nothing verifies
that the agent listens where `port` says** — keep `port` and any `PORT` in the
entry's `env` in agreement. `TELO_HOST_STATE_DIR=/var/lib/telo-agent-state` points
its durable-directory needs at the claim's `agent/`, outside the workspace tree,
so nothing syncs it and it survives suspend, resume and app-set changes.

**The workspace surface is runner infrastructure.** It is part of the `/v1`
session contract, so the runner owns its manifest, which it reconciles into a
content-addressed ConfigMap; a runner upgrade that changes the manifest leaves
running sessions mounting the one they booted with.

**One module cache per session, and it persists.** The runner seeds
`telo-workspace.yaml` at the workspace root when the pod comes up (a workspace
bringing its own marker keeps it), and the kernel anchors `.telo` there — on the
claim, so a resumed session starts warm. App containers carry no
`TELO_CACHE_DIR`, which would outrank the marker; only the `workspace` container
keeps an explicit root, because its own manifest lives outside the workspace.

**Egress lives in the session namespace.** Every app resolves its own module
closure, so the session namespace's NetworkPolicy has to reach the module
registries as well as the model provider. Core NetworkPolicy is CIDR-only, so a
locked-down operator needs a CNI with FQDN policy or an egress proxy here.

### Running an app: the session supervisor

Every `app-<name>` container's main process is the **session supervisor**, a
static executable from the runner's own build
([`packages/runner-core/supervisor`](../../packages/runner-core/supervisor),
protocol [`specs/supervisor-protocol.md`](../../packages/runner-core/specs/supervisor-protocol.md)).
It depends on nothing in the app image. The runner image carries it at
`/opt/telo-runner/supervisor`; the pod's `supervisor` init container copies it
into an `emptyDir` each app container mounts read-only.

The runner holds one WebSocket per app container to `ws://<podIP>:<port>/v1/supervisor`
with that container's token. Run sends the argv core builds
(`telo run --watch --no-input --inspect 0.0.0.0:<9230 + position> --no-open <entry>`),
the Run's env and `io`; the supervisor starts it in a process group of its own on a
fresh pty (`tty`) or pipes (`streams`), and reports `started` and `exited`, which
become the app's `running` and `ready` events. Stop is SIGTERM to the group, then
SIGKILL after the grace. **A dropped connection stops nothing**: the runner
reconnects and is replayed from its last output seq.

**A container that ends is never a run outcome.** Any container of the pod
terminating, the pod failing or being deleted, or a supervisor answering as a
restarted process fails the session, naming the container
(`container 'app-web' ended (OOMKilled, exit code 137)`). `resume` rebuilds it over
the same claim.

### Suspend, resume and storage

| Event | Pod | Session claim |
| --- | --- | --- |
| Create | Created | Created (`telo-session-<id>`, labelled `telo.run/session-id` and `app.kubernetes.io/managed-by`) |
| `PUT …/apps` (apps added or removed, a telo version or declared ports changed), `PUT …/agent` | Replaced under the same session id, once the old one is gone | Kept, mounted again |
| Suspend (idle `RUNNER_SESSION_IDLE_SECONDS`, `RUNNER_SESSION_MAX_RUNNING_SECONDS`, `POST …/suspend`) | Deleted | Kept |
| `POST …/resume` | Created, every app `ready` | Mounted again |
| `DELETE`, or retention (`RUNNER_SESSION_RETENTION_SECONDS`) | Deleted, with its Service, routing objects and session-container policies (all owned by it) | Deleted |

The claim is `ReadWriteOnce` of `RUNNER_SESSION_STORAGE_SIZE` on
`RUNNER_SESSION_STORAGE_CLASS`, and is owned by no pod, so nothing a pod's
deletion collects takes it. A replacement pod is created only once the old one is
gone, so the agent's state never has two writers.

### Restarting the runner

Session records are durable (`RUNNER_SESSION_STORE`), so a runner restart loses no
session. At boot the runner loads every record, and for each one stored as
running it **adopts** the pod it finds by the session label: it reads each app
container's supervisor token (and the agent's `tokenEnv` value) back from the pod
spec, reconnects every supervisor, and reports each app as it stands — `running`
with its run id when a run outlived the runner, `ready` otherwise. A run that was
serving keeps serving, and the runner can stop it.

- A session whose pod is gone, not running, or not the stored one (another app
  set or agent) becomes `suspended`, its pod removed and its claim kept.
- A pod whose supervisors speak **another protocol generation** predates this
  runner build: it is removed and the session becomes `suspended`, so the
  editor's `resume` builds a current pod over the same claim. This keeps boot
  fast — the runner listens only after adoption, and recreating pods there would
  hold it for minutes. A mismatch on a live workload fails the session the same
  way, and `resume` rebuilds it.
- A pod one of whose containers has ended fails the session, naming the
  container.

Then the **orphan sweep** removes every managed pod of a session that is not live
(its Service, routes and policies go with it), every session container pod of one,
every session claim of a session the store does not know, and every workspace
ConfigMap no pod mounts.

### Two nouns on one stream

*Session status* (`status` events) is `starting` / `running` / `suspended` /
`stopped` / `failed`. Each app reports an `app` event (`ready`, `running` with its
`runId`, `ready` with how a run `ended`), and a *run outcome* (`run` events) is one
per app per reload generation:

```json
{ "type": "run", "app": "web", "generation": 3, "phase": "started",   "trigger": "watch" }
{ "type": "run", "app": "web", "generation": 3, "phase": "completed", "code": 0, "durationMs": 412 }
{ "type": "run", "app": "worker", "generation": 4, "phase": "failed", "reason": "ERR_MANIFEST_VALIDATION_FAILED" }
```

Those events are **projected** from the kernel debug stream, not parsed out of the
terminal: every run is started with `--inspect`, and `Kernel.Starting` /
`Kernel.Stopped` bracket each generation on one debug connection that survives
reloads.

### A port set that changes on reload

The kernel re-resolves its `ports:` block on every load and says so on the debug
stream (`Kernel.PortsResolved`), so nothing re-parses a manifest on the reload
path. The runner patches the Service and the routing objects live and emits an
`endpoints` event; a pod's `containerPort` list is documentation, so this costs no
pod recreate. A port another app declares, the agent's port, or a port the pod
reserves cannot be routed and comes back on that same event as `rejected`. It
routes the DECLARED set, not what happened to bind; whether anything bound it is
the reachability watcher's answer, reported only while the app runs.

### Public addresses

A routed session is a **template-mode host** of the application's
`Telo.PublicUrl` needs, under the host contract in
[`@telorun/runner-core`](../../packages/runner-core/README.md#public-addresses--the-host-contract).
Every application container gets
`TELO_HOST_PUBLIC_URL_TEMPLATE=https://{port}-<session id>.<base domain>` and
`TELO_HOST_PUBLIC_URL_SECONDARY_TEMPLATE=https://{label}--{port}-<session id>.<base domain>`,
which its runs inherit and the Run's env may override. The runner routes every
host a port's `publicUrls` on `Kernel.PortsResolved` names that ends in
`-<session id>.<base domain>`, beside the port's own host, and re-routes on every
load. A host outside the session's suffix came from the session's env and is not
routed; `Telo.PublicHostPattern` and `customDomains` needs are always the session
env's.

### Reload

`POST /v1/sessions/:id/reload` touches the named app's entry manifest through the
workspace surface, so it needs no signalling into the container, no shared PID
namespace and no `exec`.

### `io` — terminal or separated streams

`io` is chosen per Run: `tty` gives the run a fresh pty, `streams` keeps its
stdout and stderr separate at the source, and `CLICOLOR_FORCE` is injected only
under `tty`. The difference is observable **to the application** — `isatty()`
drives colour, buffering, progress bars and prompts — and changing it changes
nothing about the pod. `GET /v1/sessions/:id/io?ticket=…` carries one app's
terminal; every binary frame is `[seq:4 BE][stream:1][payload]`.

### Ports are unique across the whole session

Session hosts are `<port>-<sessionId>.<base-domain>`, a single label, so two apps
both listening on 3000 would collide with nothing to distinguish them. That is a
`400 port_conflict` when the app set is created or replaced, as is an app
declaring a port the pod reserves.

## Configuration (env)

| Env | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8062` | HTTP listen port |
| `RUNNER_DISPLAY_NAME` | `Telo Runner` | Display name advertised on `/v1/capabilities` (the editor's runner label) |
| `RUNNER_DESCRIPTION` | `Runs the Telo application in a cloud environment` | Description advertised on `/v1/capabilities` |
| `RUNNER_APPS` | _(unset → no apps)_ | JSON map of the operator's agent catalog, advertised as `features.agents` (chart: inline `apps.catalog`, or `apps.catalogSecret` referencing a Secret holding the JSON — use the Secret whenever entries embed secrets in `env`); see the docker-runner README for the entry shape, including the `port` an entry must declare to be usable as a session's co-resident `agent` and the `tokenEnv` under which the runner injects a per-session workload token it reports as `token` on that workload's endpoints (minted per pod, read back from the pod spec when a restarted runner adopts it). |
| `RUNNER_SUPERVISOR_IMAGE` | _(required; the chart sets it to the runner's own image)_ | The runner's own image, which every session pod's `supervisor` init container copies the session supervisor out of (from `/opt/telo-runner/supervisor`) |
| `RUNNER_APP_MAX_CPU` | `500m` | CPU ceiling of the co-resident agent's container (chart: `limits.agent.maxCpu`) |
| `RUNNER_APP_MAX_MEMORY` | `512Mi` | Memory ceiling of the co-resident agent's container (chart: `limits.agent.maxMemory`) |
| `RUNNER_APP_MAX_EPHEMERAL_STORAGE` | `1Gi` | Ephemeral-storage ceiling of the co-resident agent's container (chart: `limits.agent.maxEphemeralStorage`) |
| `RUNNER_SESSION_NAMESPACE` | `telo-sessions` | Namespace for session objects |
| `RUNNER_IMAGE` | _(baked at build: the CLI version for a released runner, `telorun/node:latest-slim` for a dev build)_ | Default base image; always offered in the picker and the fallback when the catalog is unreachable. Leave the chart's `session.image` empty to keep the session kernel in lockstep with the runner |
| `RUNNER_TELO_IMAGE_REPOSITORY` | `telorun/node` | Where the kernel image of a telo version an application names is pulled from: `<repository>:<version>-<variant>`. Point it at a mirror or a private registry (chart: `session.teloImages.repository`) |
| `RUNNER_TELO_IMAGE_VARIANT` | `slim` | The variant suffix of that image tag (chart: `session.teloImages.variant`) |
| `RUNNER_TELO_UNRELEASED_IMAGE` | _(unset → refused)_ | The kernel image an unreleased build identity (`X+unreleased`) runs on (chart: `session.teloImages.unreleased`) |
| `RUNNER_PULL_POLICY` | `missing` | The `imagePullPolicy` of a session whose applications name a telo version: `missing`, `always` or `never` (a cluster that preloads its images) (chart: `session.teloImages.pullPolicy`) |
| `RUNNER_IMAGE_PULL_SECRET` | _(unset)_ | dockerconfig Secret (in `telo-sessions`) the kubelet pulls session images with — needed only for a kernel or catalog image in a private registry |
| `RUNNER_RUNTIME_CLASS` | _(unset → runc)_ | Sandbox RuntimeClass (gvisor/kata) |
| `SESSION_ROUTING_MODE` | `auto` | `auto` \| `ingress` \| `gateway` \| `none`. See [Routing layer](#routing-layer) |
| `SESSION_ROUTING_BASE_DOMAIN` | _(unset → logs-only)_ | Wildcard base for per-session hosts |
| `SESSION_ROUTE_READY_TIMEOUT_SECONDS` | `60` | How long a published route may go unclaimed before the session reports it `unprogrammed` |
| `SESSION_INGRESS_CLASS` | _(unset → cluster default)_ | IngressClass for session Ingresses (ingress mode) |
| `SESSION_INGRESS_TLS_SECRET` | _(unset → no TLS block)_ | `kubernetes.io/tls` Secret (in `telo-sessions`) the session Ingress presents; must cover `*.<base-domain>`. Set for Cloudflare Full (Strict) / any origin-cert upstream. **Ingress mode only** — refused at boot in gateway mode, where the cert belongs to the Gateway listener |
| `SESSION_GATEWAY_NAME` | _(unset)_ | Gateway each session's HTTPRoute attaches to. Required in gateway mode |
| `SESSION_GATEWAY_NAMESPACE` | _(= session namespace)_ | Namespace of that Gateway |
| `SESSION_GATEWAY_SECTION_NAME` | _(unset → any listener)_ | Listener name, when only one should carry session traffic |
| `RUNNER_MAX_CPU` | `500m` | CPU ceiling of each `app-<name>` container and the `workspace` container (chart: `limits.maxCpu`) |
| `RUNNER_MAX_MEMORY` | `512Mi` | Memory ceiling of each `app-<name>` container and the `workspace` container (chart: `limits.maxMemory`) |
| `RUNNER_MAX_EPHEMERAL_STORAGE` | `1Gi` | Ephemeral-storage ceiling of each `app-<name>` container and the `workspace` container (chart: `limits.maxEphemeralStorage`) |
| `RUNNER_MAX_SESSIONS` | `8` | Most running sessions at once; suspended ones do not count (chart: `runner.maxSessions`) |
| `RUNNER_SESSION_IDLE_SECONDS` | `300` | No SSE/WS subscriber for this long → suspend (chart: `sessions.idleSeconds`) |
| `RUNNER_SESSION_MAX_RUNNING_SECONDS` | `21600` | A running session suspends after this long. One deadline covers the agent and the app containers, so it takes the longer ceiling and lets idleness do the real work (chart: `sessions.maxRunningSeconds`) |
| `RUNNER_SESSION_RETENTION_SECONDS` | `2592000` | A suspended session is deleted with its storage after this long — 30 days (chart: `sessions.retentionSeconds`) |
| `RUNNER_SESSION_RELOAD_LIMIT` | `30` | Per-session reloads per minute (chart: `sessions.reloadLimit`) |
| `RUNNER_SESSION_STORE` | `sqlite` | Where session records are kept: `sqlite` (a file in `RUNNER_STATE_DIR`) or `postgres`. Anything else refuses to boot (chart: `sessionStore.kind`) |
| `RUNNER_SESSION_STORE_URL` | _(unset)_ | The Postgres connection URL; required with `postgres`, refused with `sqlite` (chart: `sessionStore.url` or `sessionStore.existingSecret`) |
| `RUNNER_STATE_DIR` | _(required with `sqlite`)_ | The runner's own state directory, on persistent storage; holds `sessions.sqlite` (the chart mounts its own claim, `telo-k8s-runner-state`, at `/var/lib/telo-runner` with `sqlite`) |
| `RUNNER_SESSION_STORAGE_SIZE` | `5Gi` | Size of each session's own PersistentVolumeClaim, a Kubernetes storage quantity (chart: `sessionStorage.size`) |
| `RUNNER_SESSION_STORAGE_CLASS` | _(unset → cluster default)_ | StorageClass of each session's own PersistentVolumeClaim (chart: `sessionStorage.storageClass`) |
| `RUNNER_IDENTITY_AUDIENCE` | _(unset)_ | The runner's public https base URL, the audience a signed-in owner's DPoP-bound token must name; set with `RUNNER_IDENTITY_ISSUERS` or not at all (chart: `identity.audience`) |
| `RUNNER_IDENTITY_ISSUERS` | _(unset)_ | Comma-separated https issuers whose tokens are accepted (chart: `identity.issuers`, a list) |
| `RUNNER_SESSION_CONTAINERS` | `false` | Serve every session a container engine of its own (chart: `session.containers.enabled`) — see [Session containers](#session-containers) |
| `RUNNER_SESSION_CONTAINERS_MAX` | `4` | Most containers one session may hold at once; a create beyond it is `429` (chart: `session.containers.max`) |
| `RUNNER_SESSION_CONTAINERS_RESOURCES` | _(limits 500m CPU, 512Mi memory, 1Gi ephemeral storage; requests 500m CPU, 512Mi memory)_ | Every session container's pod `resources`, as JSON `{"limits": {…}, "requests": {…}}` (chart: `session.containers.resources`) |
| `RUNNER_INTERNAL_URL` | _(required when containers are on)_ | The runner as a session pod reaches it; the chart sets it to the runner's Service |
| `RUNNER_TERMS_FILE` | _(unset)_ | Path to the agreement file (plain text / markdown), read at startup — mount it from a `ConfigMap` (e.g. `/etc/telo/terms.md`). Setting this (or `RUNNER_TERMS_BODY`) enables terms: the runner advertises them on `/v1/capabilities` and rejects `POST /v1/sessions` with `428` unless the client sends `x-telo-accepted-terms` matching the version. An unreadable path fails startup. The public cloud should set this |
| `RUNNER_TERMS_BODY` | _(unset)_ | Inline agreement text, for short notes; ignored when `RUNNER_TERMS_FILE` is set |
| `RUNNER_TERMS_TITLE` | `Usage agreement` | Heading shown above the agreement |
| `RUNNER_TERMS_VERSION` | _(hash of body)_ | Acceptance version; defaults to a content hash so any edit to the body automatically re-prompts every client. Set explicitly only to control material-change vs typo |

A runner started with a variable this release no longer reads refuses to boot, naming each one: `RUNNER_WATCH_MAX_SESSIONS`, `RUNNER_WATCH_IDLE_SECONDS`, `RUNNER_WATCH_MAX_TTL_SECONDS`, `RUNNER_WATCH_SUSPENDED_TTL_SECONDS` and `RUNNER_WATCH_RELOAD_LIMIT` are renamed to `RUNNER_MAX_SESSIONS`, `RUNNER_SESSION_IDLE_SECONDS`, `RUNNER_SESSION_MAX_RUNNING_SECONDS`, `RUNNER_SESSION_RETENTION_SECONDS` and `RUNNER_SESSION_RELOAD_LIMIT`; `RUNNER_WATCH_SESSIONS`, `RUNNER_WORKSPACE_CHECKPOINT_SECONDS`, `RUNNER_EXIT_TTL_MS`, `RUNNER_MAX_TTL_SECONDS` and `RUNNER_APP_MAX_TTL_SECONDS` are removed, and so are `RUNNER_SELF_URL` and `RUNNER_INIT_IMAGE`, which served the bundle fetch (the chart's `session.initImage` is refused the same way).

### The telo version an application runs on

A session request may name, per application, the telo version it runs on
(`telo`, on each entry of `apps`, or on the request for a single-app session) —
the version the editor checks that module against. The runner advertises
`features.teloVersions` and runs that application's container on
`<RUNNER_TELO_IMAGE_REPOSITORY>:<version>-<RUNNER_TELO_IMAGE_VARIANT>`, never a
substitute. The base-image catalog does not gate this: it is the menu
`config.image` is picked from — a bounded, newest-first list read from
`RUNNER_BASE_IMAGE_REPO` — while which versions may run is the telo image
source's own rule. An image the cluster cannot pull fails the session on its
event stream, since a pull happens on a node after the pod exists. A release
older than 0.123.0, the oldest a runner is verified to supervise, is refused
before the session exists (`400 telo_version_unavailable`). An unreleased build
(`0.80.0+unreleased`) has no published image: it runs on
`RUNNER_TELO_UNRELEASED_IMAGE` when the operator set one (a development stack
whose editor is built from the same tree), and is refused naming that variable
otherwise. The pod's own `workspace` container always runs on `RUNNER_IMAGE`.

`config.image` and `config.pullPolicy` are **deprecated**: they are what a client
naming no version still sends, and they behave as before for that client. A
request naming a version beside either is `400 invalid_config` — a version's
image is pulled under the operator's `RUNNER_PULL_POLICY`, applied as the Pod's
`imagePullPolicy` — and a session's applications either all name a version or
none does.

Each generation's `run` event carries the version the runtime itself reported
(`telo`), passed on unjudged — the editor compares it with what it asked for and
warns on a difference.

### Session containers

With `session.containers.enabled=true` every session gets
`TELO_HOST_CONTAINER_ENGINE_URL` (`<runner Service>/v1/sessions/<id>/engine`) and
`TELO_HOST_CONTAINER_ENGINE_TOKEN`, so a test that starts its own database
through `Docker.Engine` runs in a session exactly as it runs locally — with no
credentials in the session pod and no privileged container anywhere. The runner
answers the Engine API requests `Docker.Engine` sends behind the session's token
(the contract, refusals and ceiling are `@telorun/runner-core`'s, in its README)
and runs each container as a pod in the session namespace:

- under the namespace's `restricted` Pod Security standard: `runAsNonRoot`, the
  `User` as `runAsUser` / `runAsGroup`, all capabilities dropped, no privilege
  escalation, `RuntimeDefault` seccomp, no service-account token. A user that is
  not a numeric non-root `uid[:gid]` is a `400` naming `User`;
- with `session.containers.resources`, which the namespace's `ResourceQuota`
  counts like any session pod — so enabling this requires raising
  `resourceQuota.hard` by the container term: `pods` by `runner.maxSessions` ×
  `session.containers.max`, and `requests.cpu` / `requests.memory` (and
  `limits.cpu` / `limits.memory`) by `runner.maxSessions` ×
  `session.containers.max` × the container's requests (limits). At the defaults
  that is pods 32 → 160, cpu 16 → 80 (32 × 4 × 500m = 64, plus 16) and memory
  16Gi → 80Gi; without it the quota, not `runner.maxSessions`, caps concurrency,
  as a 403 the client sees;
- labelled `run.telo.session=<id>` and the runner's managed-by label — never
  `telo.run/session-id`, so the session's Service does not select it — and owned
  by the session's pod, so the cluster collects it with that pod;
- reachable only from that session's pods, through two NetworkPolicies the runner
  creates per session (`telo-ctr-<id>-ingress`, `telo-ctr-<id>-egress`, owned by
  the session's pod and deleted when the session ends); the Role gains
  `networkpolicies` when the setting is on;
- at its pod IP and container port, which inspect answers in the binding the
  client asked for — no host or node port is bound;
- removed when the session ends, stops, suspends or is deleted, and at boot with
  every other pod carrying the managed-by label.

The node pulls a container's image when its pod starts, so image inspect and
pull answer at once and an image that cannot be pulled fails the start with the
kubelet's reason. `.github/workflows/e2e.yml` installs this chart on kind with
the setting on and runs a container-backed integration test as a session
(`node scripts/runner-containers-e2e.mjs --kubernetes`).

### Base-image picker

The runner advertises a menu of base images on `/v1/capabilities`, resolved from
a Docker Hub repo's tags (filtered) and cached. The editor renders it as an
editable `image` dropdown; the chosen image is **re-validated server-side**
against the same list, so a client that skips the editor can't widen the set.
`RUNNER_IMAGE` is always offered and is the fallback when Docker Hub is
unreachable. Disable the catalog to lock `image` to `RUNNER_IMAGE`.

Pinned tags (e.g. `0.30.1-slim`) are immutable. A picked **moving** tag like
`latest-slim` only refreshes when the session's `pullPolicy` is `always`, which
is the Pod's own `imagePullPolicy`: the kubelet re-pulls the tag on every
session. `missing` and `never` reuse whatever that node already cached.

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

## Deploy (Helm)

The chart is published as an OCI artifact at
`oci://ghcr.io/telorun/charts/k8s-runner`:

```bash
helm install telo-runner oci://ghcr.io/telorun/charts/k8s-runner \
  --set session.runtimeClass=gvisor
```

Helm resolves the newest release when no `--version` is given; pass one to pin.
From a checkout, `./chart` works the same way and is what you want when changing
the chart itself.

**The chart's version IS the runner's.** `version` and `appVersion` both carry
`@telorun/k8s-runner`'s package version, stamped in the release PR and checked on
every PR — so chart `0.13.0` installs runner image `0.13.0`, with no lookup
table. That is also why `image.tag` defaults to empty and resolves to the chart's
own `appVersion` rather than to `latest`: `--version 0.13.0` has to mean one
thing, where a floating tag meant whatever it had moved to overnight.

The chart provisions the static scaffolding: the runner Deployment (single
replica — live streams are in-process, and the runner adopts and sweeps session
pods at boot), Service, scoped RBAC (pods, services, PersistentVolumeClaims,
ConfigMaps and routing objects in `telo-sessions`; no `pods/attach`), the
`telo-runner` and restricted-PSS `telo-sessions` namespaces, a `ResourceQuota`,
the session pod-to-pod NetworkPolicy (which admits the runner's namespace on every
port, the session supervisors' included), and — with `sessionStore.kind: sqlite`,
the default — the runner's own PersistentVolumeClaim `telo-k8s-runner-state`,
kept on uninstall. The runner creates per-session objects at runtime, each
session's claim included. Nothing else is required — no image registry, no build
namespace, no push credentials.

| Value | Default | Meaning |
| --- | --- | --- |
| `sessionStore.kind` | `sqlite` | `sqlite` (on the runner's own claim) or `postgres` |
| `sessionStore.persistence.size` / `.storageClass` | `1Gi` / cluster default | The runner's own claim, with `sqlite` |
| `sessionStore.url` / `.existingSecret` (+ `.existingSecretKey`, `url`) | — | The Postgres connection URL, inline or from a Secret; one of them with `postgres` |
| `sessionStorage.size` / `.storageClass` | `5Gi` / cluster default | Each session's own claim |
| `identity.audience` / `identity.issuers` | — | Signed-in owners; set both or neither |
| `limits.maxCpu` / `.maxMemory` / `.maxEphemeralStorage` | `500m` / `512Mi` / `1Gi` | Each app container and the `workspace` container |
| `limits.agent.maxCpu` / `.maxMemory` / `.maxEphemeralStorage` | `500m` / `512Mi` / `1Gi` | The agent's container |

A session pod's `supervisor` init container runs the runner's own image
(`image.repository:image.tag`), pulled by the node into `telo-sessions` — so a
runner image held in a private registry needs `session.imagePullSecret` there
too.

For a kernel image or an operator catalog image held in a **private registry**,
create the dockerconfigjson Secret in `telo-sessions` yourself and point
`session.imagePullSecret` at it; the kubelet pulls with it.

### Routing layer

Session hosts are `<port>-<sessionId>.<base-domain>` — a single label, so one
wildcard DNS record and one wildcard cert cover every session. **Both current
routing APIs are supported**, because clusters ship Ingress, Gateway API, or
both, and hardcoding either leaves the runner unroutable on the rest.

`sessionRouting.mode` picks the layer:

| mode | behaviour |
| --- | --- |
| `auto` (default) | Resolve from what is **configured**, then from what the cluster serves |
| `ingress` | `networking.k8s.io/v1` Ingress |
| `gateway` | `gateway.networking.k8s.io` HTTPRoute (`v1`, falling back to `v1beta1`) |
| `none` | Publish nothing — logs-only even with a base domain set |

`auto` reads configuration before installation, and that order is the point: a
named Gateway wins, then a configured IngressClass, then a **default-marked**
IngressClass (`ingressclass.kubernetes.io/is-default-class` — the cluster has
nominated where an unqualified Ingress goes, and unqualified is what this runner
creates), and only then does it look at what merely exists. **Gateway API CRDs are frequently present without being the intended
path**, so "the API exists" is not evidence of intent. Where two usable layers
exist and nothing was configured, the runner **refuses to start** rather than
guessing — a wrong guess publishes routing objects nothing reconciles, which
produces a healthy pod and a 404 on every URL, with nothing reported anywhere.

```bash
# Gateway API
helm install telo-runner ./chart \
  --set sessionRouting.mode=gateway \
  --set sessionRouting.baseDomain=telo.run \
  --set sessionRouting.gateway.name=public \
  --set sessionRouting.gateway.namespace=gateway-system \
  --set sessionRouting.dataPlaneNamespace=gateway-system
```

The Gateway needs a listener whose hostname covers `*.<base-domain>` and whose
`allowedRoutes.namespaces` admits `telo-sessions`. A route it does not admit is
reported per session with the controller's own reason (`NotAllowedByListeners`).

**Upgrading from `sessionIngress.*`** is a breaking values change and the chart
refuses the old keys rather than ignoring them — Helm drops unknown values
silently, so an un-migrated file would otherwise boot a runner that logs
`session routing disabled (logs-only)` and drops every session URL.

> **One HTTPRoute per port.** Gateway API scopes `hostnames` to the whole route
> while a rule matches on path, never host — so a single route carrying every
> session hostname would send them all to whichever rule matched `/` first. An
> Ingress rule owns its host, which is why that layer needs only one object.

**`sessionRouting.dataPlaneNamespace` is not optional when routing is on.** The
session NetworkPolicy admits traffic from that namespace only; without it the
route programs correctly and the workload is still unreachable.

### Route verification

The runner already dials each declared port from its own network — that proves
the app is **listening** and says nothing about whether traffic can **reach** it.
So it separately verifies that what it published was actually programmed, and
reports each host as `pending` → `programmed` / `unprogrammed` on the session
event stream (`type: "route"`). Reported, never fatal: a slow controller and an
absent one look alike for the first few seconds.

Gateway API answers this precisely, from the `Accepted` / `ResolvedRefs`
conditions a controller writes. Ingress has no rejection signal — a controller
that refuses a rule simply never writes status — so there an unclaimed route is
caught by the timeout rather than by a reason the cluster gave.

### Origin TLS (Cloudflare et al.)

**Ingress mode only.** Under Gateway API the origin certificate belongs to the
Gateway listener's own `certificateRefs`; setting `SESSION_INGRESS_TLS_SECRET`
alongside `mode: gateway` is refused at boot rather than silently ignored.

To have the per-session Ingress present an origin cert (so an upstream like
Cloudflare in **Full (Strict)** mode validates the origin), give the chart a
`kubernetes.io/tls` Secret in `telo-sessions`. The cert must cover the wildcard
`*.<sessionRouting.baseDomain>` — session hosts are a single label
(`<port>-<sessionId>.<base-domain>`). Two ways:

```bash
# A — reference a Secret you manage in telo-sessions (cert-manager, your own sync)
helm install telo-runner ./chart --set sessionRouting.ingress.tls.secretName=telo-origin-tls

# B — let the chart create the Secret from your cert + key
helm install telo-runner ./chart \
  --set-file sessionRouting.ingress.tls.cert=origin.pem \
  --set-file sessionRouting.ingress.tls.key=origin.key
```

Either wires `SESSION_INGRESS_TLS_SECRET`, and the runner stamps a `spec.tls`
block on every session Ingress. Leave all three empty to skip TLS at the origin
(terminated entirely upstream).

> **Egress note.** Core NetworkPolicy is CIDR-only and cannot express the
> package-registry FQDN allowlist the session namespace needs — use a CNI with
> FQDN policy (Cilium) or an egress proxy to tighten it.

## Development

```bash
pnpm --filter @telorun/k8s-runner build   # tsc
pnpm --filter @telorun/k8s-runner test    # vitest
```

The tests drive the backend against a fake session namespace whose "kubelet"
brings each created pod up on a loopback address of its own, with the workspace
surface and a supervisor speaking the protocol on each app container's port:
pod shape, storage across suspend, resume and delete, runs, adoption and the
orphan sweep. A real cluster is `.github/workflows/e2e.yml`'s.
