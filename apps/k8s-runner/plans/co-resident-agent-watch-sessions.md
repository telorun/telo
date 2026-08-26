# Co-resident agent + watch sessions

## The finding

The dev loop is slow because **a session is one run**. Every edit creates a session,
which on Kubernetes means: dependency-closure key → registry existence check →
(maybe) an on-cluster image build → pod schedule → image pull → body-fetch init →
kernel boot. Even a full cache hit pays the last four.

The fix is to make **a session a workspace that runs continuously**: one pod, a
workspace volume, `telo run --watch` over it, and the authoring agent as another
container writing into that same volume. An edit then costs a kernel reload
instead of a pod.

This is smaller than what it replaces. The agent already runs one container per
session with the operator credential injected server-side, so co-locating widens
no trust boundary — and a shared volume that N watchers observe removes the
body-fetch init container, the per-session bundle re-fetch, and the separate agent
session entirely.

---

## Before

| | Today |
| --- | --- |
| Session | One pod per Run click; terminal when the workload exits |
| Body delivery | Tokenized tarball, fetched once by an init container into `/app` |
| Dependencies | Baked per app by an on-cluster build into a read-only `/telo-cache`; run with `--no-cache-write` |
| Agent | A separate session (`POST /v1/apps/authoring-agent/sessions`), its own pod, its own workspace directory |
| Agent → app | None. The agent can validate what it writes; it cannot run it |
| Agent → editor | Editor polls the agent's `/workspace` snapshot |
| Editor → app | Full bundle in the session-create body |
| Re-run | New session, new pod |

The agent authors blind: it has static validation and no running app.

## After

One pod, one workspace, and one container per running application.

| Container | Image | Present | Writes | Credential | Hardening |
| --- | --- | --- | --- | --- | --- |
| `workspace` | Runner-owned workspace image | Always | `/workspace` | None | Hardened; holds no secrets |
| `agent` | Operator catalog image (the authoring agent) | When `agent` is requested | `/workspace` | Operator env (LLM key) | Relaxed, as app sessions are today |
| `app-<name>` | Session base image | One per app | `/work`, `/telo-cache/<name>`, `/home`, `/tmp` | Session-declared env only | Unchanged: non-root, read-only rootfs, drop-all caps, no SA token, seccomp `RuntimeDefault` |

**The workspace surface is runner infrastructure, not agent functionality.** It is
part of the `/v1` session contract, so the runner owns its image and its routes;
the agent is one more writer on the volume beside the app containers. Hanging it
off the catalog image would invert the dependency — the session contract would
rest on an application the operator configures — and would need a second
implementation for the agentless case, with the contract depending on the two
staying in agreement.

The agent needs no part of that surface: its existing filesystem tools write to
the shared volume directly. `workspace` serves the **editor**, and nothing else.

Volumes:

| Volume | Mount | Mode | Containers |
| --- | --- | --- | --- |
| `workspace` | `/workspace` | rw | all |
| `telo-cache` | `/telo-cache` | rw | every `app-<name>` |
| `work`, `home`, `tmp` | as today | rw | every `app-<name>` |

**At most one agent per session, never per app.** The agent's unit is the
workspace — it edits files, it does not own a process. Two agents over one
workspace would contend on the same files and split one conversation in half.

Each `app-<name>` container downloads the modules its closure needs into its own
subdirectory of the shared cache volume (`TELO_CACHE_DIR=/telo-cache/<name>`),
which lives as long as the pod — so the download happens once per app per session
and every later reload resolves from local disk. One writable cache root per app
is all a watch session needs, so nothing in the kernel or the CLI changes here: it
is today's cache behaviour pointed at an emptyDir bounded by the existing
`ephemeral-storage` limit. Per app rather than shared, because two apps in one
workspace may legitimately pin different versions of the same module.

Each app container runs `telo run /workspace/<entry> --watch`. Writes reach the
volume two ways and only two: the **agent** writes files directly with its own
filesystem tools, and everyone outside the pod — the editor above all — goes
through the `workspace` container's HTTP surface. Both land on one volume that N
watchers observe, which is what replaces three delivery paths.

**Most workspaces have exactly one app.** One Application with several Services in
its `targets:` is one kernel and one container; a child manifest run through the
runtime seam (how the test module runs a suite) needs no container of its own. The
multi-container case is specifically **two independent Applications**, which
genuinely cannot be merged — importing a `Telo.Application` is a hard error, so no
manifest composes them.

---

## Part 1 — A session outlives its runs

**Before.** `status: exited` is terminal; the registry schedules eviction on it.
That is correct when a session is one run and wrong the moment the kernel can
reload.

**After.** Two nouns, reported separately on the same stream.

*Session status* (`status` events, unchanged field, new value):

| Value | Meaning |
| --- | --- |
| `starting` | Pod provisioning |
| `running` | Every `app-<name>` container is up |
| `suspended` | Reaped for idleness; the workspace checkpoint is held and the session can resume |
| `stopped` | User stopped, or TTL reached |
| `failed` | The session could not be brought up, or an `app-<name>` container died unrecoverably |

*Run outcome* (new `run` event, one per app per reload generation):

```json
{ "type": "run", "app": "web",    "generation": 3, "phase": "started",   "trigger": "watch" }
{ "type": "run", "app": "web",    "generation": 3, "phase": "completed", "code": 0, "durationMs": 412 }
{ "type": "run", "app": "worker", "generation": 4, "phase": "failed",    "reason": "ERR_MANIFEST_VALIDATION_FAILED" }
```

`generation` is monotonic **per app** and starts at 1. A one-shot Runnable
finishing emits `run.completed` and leaves `status: running` — the session is
alive and the next edit starts that app's next generation.

`app` qualifies `progress` and `debug` the same way, for the same reason: a
session with several containers reports several of each, and today's events carry
nothing to tell them apart. Adding the qualifier now is cheap; retrofitting it
onto events clients already parse is not, and a single-app session carries it too
so no client needs two readings.

**Workload output does not travel the event channel, in either mode.** It goes
over the byte channel (`/io`), which exists precisely because per-chunk events are
wasteful for high-volume output. `RunEvent` currently declares `stdout` and
`stderr` variants that **nothing emits** — dead types that read as a contract and
are not one. They are deleted here rather than qualified, and the docker-runner
README's claim that the SSE stream carries them is corrected in the same change.

**The byte channel becomes per app.** Each app container has its own terminal, so
the runner's byte buffer is keyed `(session, app)` and `/io?app=<name>` subscribes
to one. That is what a multi-app session needs — not a label on a merged stream.

**Where `run` events come from — the wire already carries them.** The runner
cannot see inside the container, and parsing the merged PTY stream is not a
contract. Watch sessions therefore always run with the kernel debug stream on,
which the runner already relays to `/v1`, and the runner **projects** `run` events
from the kernel lifecycle events already on it: `Kernel.Starting` / `Kernel.Started`
become `phase: "started"`, and `Kernel.Stopped` — which already carries
`exitCode` — becomes `phase: "completed"`. A watch reload is a stop/start pair on
one debug connection, so `generation` is counted by the runner and asks the kernel
for nothing.

**Exactly one new event, and it is a dotted name, not a frame kind.** A load or
validation failure *before* start is genuinely not on the wire today, and flow 5
depends on it. The debug wire's frame-kind set (`log`, `record`, event) is the
language-neutral conformance contract every kernel must implement, while the
dotted event vocabulary inside an event frame is already open — so a new event
name obliges no other runtime, and a new frame kind would oblige all of them.

Because nothing new is required of the base image for the common cases, there is
no version-skew caveat here: an older CLI reports started and completed exactly as
a current one does, and loses only the pre-start failure reason.

**Verify.** Start a watch session on a one-shot app; assert the stream carries
`run.completed` while `status` stays `running`, and that the registry schedules
no eviction. Then edit a file and assert `generation` increments.

---

## Part 2 — Co-resident pod

**Session creation.** `POST /v1/sessions` gains three optional fields, all
server-validated and all advertised `readOnly` on `/v1/capabilities` when the
operator locks them:

```json
{
  "bundle": { "entryRelativePath": "telo.yaml", "files": [ … ] },
  "env": { },
  "config": { "image": "telorun/node:latest-slim", "pullPolicy": "missing" },
  "mode": "watch",
  "agent": "authoring-agent",
  "apps": [
    { "name": "web",    "entryRelativePath": "telo.yaml",    "ports": [{ "port": 3000, "protocol": "tcp" }], "io": "tty" },
    { "name": "worker", "entryRelativePath": "worker.yaml",  "io": "streams" }
  ]
}
```

`mode` defaults to `"run"` (today's behaviour, unchanged). `agent` names a
catalog entry; an unknown name is `400 unknown_agent`. `agent` without
`mode: "watch"` is `400 agent_requires_watch` — an agent with nothing watching
its writes is a silent no-op.

`apps` is the set of applications this session runs, one container each. Omitted,
it defaults to a single app named `app` taking the bundle's own
`entryRelativePath` and the request's `ports` — so a single-app session is written
exactly as it is today. A name must be unique within the session and usable as a
DNS label, since it appears in the container name and the run events.

**`io` chooses whether the app runs under a terminal, per app.** It defaults to
`"tty"` — today's behaviour, and the right default for a dev loop. The difference
is observable **to the application**, not just to the runner: `isatty()` drives
color, line-versus-block buffering, progress bars and prompts, so a loop that is
always a PTY systematically hides how the app behaves in production. The CLI's own
`Output` seam is the case in point — under `-o json` stdout carries the payload
and prose goes to stderr, and that split cannot be exercised at all under a merged
terminal.

| | `tty` | `streams` |
| --- | --- | --- |
| Output | One merged stream, as a terminal produces | Separated at the source |
| `/io` resize | Yes | Rejected — meaningless without a PTY |
| `FORCE_COLOR` / `CLICOLOR_FORCE` | Injected | **Not** injected |

Nothing is invented at the transport layer: Docker's non-TTY attach returns a
multiplexed stream carrying a per-frame stream id, and the Kubernetes attach
subresource without a TTY gives separate stdout and stderr channels. The demux is
already there — the TTY is what collapses it.

The color row is the one that would otherwise be missed. Both runners inject those
variables unconditionally today; forcing color in a mode whose whole purpose is
"show me what production sees" defeats the mode, putting ANSI into what is meant
to be a pipe.

**Every byte-channel chunk carries a `stream` tag** — `"tty"` under `io: "tty"`,
`"stdout"` or `"stderr"` under `io: "streams"`. The tag never asserts a split that
does not exist, which is exactly the failure the deleted `RunEvent` variants
represented. `/v1/capabilities` advertises the modes a runner offers, and a client
attached to a `streams` app must drop resize from its terminal.

**Ports are unique across the whole session.** Session hosts are
`<port>-<sessionId>.<base-domain>`, a single label, so two apps both listening on
3000 collide with nothing to distinguish them. A collision is `400 port_conflict`
at session create rather than an app name added to the host scheme: the user
controls both manifests, and a rejected request is a better outcome than a URL
that silently reaches the wrong app.

`POST /v1/apps/:name/sessions` is unchanged and still serves operator-predefined
app sessions that carry no user bundle.

**Capabilities.**

```json
{
  "displayName": "Telo Runner",
  "features": { "io": ["tty", "streams"], "ports": true, "watch": true, "agents": ["authoring-agent"] },
  "config": { "schema": { … } }
}
```

**Env split is the credential boundary.** The operator env from the catalog goes
on the `agent` container only; every `app-<name>` container receives the session's
declared env and nothing else, and `workspace` receives neither — it serves files
and holds no secrets. This was structural (two pods) and becomes a code invariant
(containers in one pod), so it needs a test that asserts no catalog key appears in
any container but `agent`.

**Pod-level settings that are now shared.** `runtimeClass`,
`automountServiceAccountToken` and the seccomp profile are pod-scoped; all three
are already identical or safe at the stricter value. `securityContext` is
per-container, so every app container keeps its full hardening while the
`workspace` container keeps the relaxed profile app sessions have today.

**A shared GID is required.** Every container reads and writes `/workspace`, so
the pod needs an `fsGroup` they all share — today the two pod shapes disagree (one
pins `1000:1000` with `fsGroup: 1000`, the other lets the image's user apply).
Without this the agent writes files the app cannot read, which surfaces as a
manifest that "does not exist" one reload after it was written.

**Ingress is unchanged.** Session hosts are already `<port>-<sessionId>.<base-domain>`,
so the workspace container's port and each app's ports are entries in the same
scheme — which is exactly why session-wide port uniqueness is enforced above.

**Shared network namespace.** Every app container can reach the workspace
container, and each other, on localhost. Under one agent per session that is the
user's own agent and their own budget slice; between a user's own apps it is the
same trust domain — contained, but stated rather than discovered.

**Egress moves into the session namespace.** Module fetches used to be scoped to
the build namespace; a watch session resolves them itself, so the session
namespace's NetworkPolicy has to reach module registries as well as the model
provider. Core NetworkPolicy is CIDR-only and registries sit behind rotating-IP
CDNs, so a locked-down operator needs a CNI with FQDN policy or an egress proxy
here — the same stated dependency the build namespace carries today, now one
namespace over. Run sessions are unaffected.

**Watch sessions never build an image.** The build path exists to put a closure on
disk before boot; a watch session fetches its own and keeps it for the pod's life.
Run sessions keep the build exactly as today.

**Verify.** Assert no app container's env carries a catalog key; assert a file
written through the workspace API is readable by every app container; assert an
app container's `securityContext` is byte-identical to today's session pod; assert
two apps declaring the same port are rejected at create.

---

## Part 3 — Lifetime, idleness and resume

**Before.** `activeDeadlineSeconds` from a per-tier TTL ceiling; the session ends
when the workload exits. Run sessions cap at 1h, app sessions at 6h.

**After.** Merged, so one deadline covers both containers — take the longer
(agent) ceiling and let idleness do the real work, or the conversation dies at an
hour mid-turn.

| Surface | Default | Purpose |
| --- | --- | --- |
| `RUNNER_WATCH_SESSIONS` | `false` | Server-side gate. Watch sessions are never client-requestable when off |
| `RUNNER_WATCH_IDLE_SECONDS` | `300` | No SSE/WS subscriber for this long → suspend |
| `RUNNER_WATCH_MAX_TTL_SECONDS` | `21600` | Pod deadline for a watch session |
| `RUNNER_WATCH_MAX_SESSIONS` | `8` | Separate concurrency ceiling from `RUNNER_MAX_SESSIONS` |
| `RUNNER_WATCH_RELOAD_LIMIT` | `30/min` | Per-session reload rate limit |
| `RUNNER_WATCH_SUSPENDED_TTL_SECONDS` | `86400` | How long a suspended session record is retained before eviction — bounds accumulation, and is not the pod deadline |
| `RUNNER_WORKSPACE_CHECKPOINT_SECONDS` | `30` | How often the runner pulls a workspace snapshot |

**A session is no longer a pod.** The runner pulls a **whole-tree** workspace
snapshot on the checkpoint timer and again on suspend; suspending deletes the pod
and keeps the session record and its snapshot. `POST /v1/sessions/:id/resume`
creates a fresh pod seeded from the checkpoint under the same session id. This is
what makes aggressive reaping affordable, and aggressive reaping is what makes
per-visitor watch sessions affordable — they only work as a pair.

**The editor holds the authoritative workspace; the checkpoint is a cache.** This
is the load-bearing statement, because the runner is a single replica with an
in-memory session registry — so a redeploy, crash or node move drops every
suspended session, and a runner-side store would be the only thing standing
between that and lost user work. It buys less than it looks: a durable suspended
workspace is only meaningful when there is an **identity to reattach it to**, and
accounts and named projects are an explicit non-goal. A watch session exists
because an editor is driving it, that editor already holds every file and already
diffs its own copy against `GET /workspace`, so on a `404` at resume it creates a
new session and re-seeds from its own copy in one change set. The checkpoint saves
that upload; it never carries the only copy.

Two consequences, both stated rather than discovered:

- A suspended session is **best-effort**. A runner restart loses it, the editor
  reconnects, and the user sees a new session id with their files intact.
- A watch session with **no editor attached and unsaved agent writes** is the one
  place work can be lost — bounded by `RUNNER_WORKSPACE_CHECKPOINT_SECONDS` and by
  the fact that the agent only runs while a client is driving it.

`RUNNER_WATCH_SUSPENDED_TTL_SECONDS` bounds how long suspended records accumulate,
and is deliberately separate from the pod deadline: `RUNNER_WATCH_MAX_TTL_SECONDS`
bounds a *pod*, so on its own nothing would ever evict a suspended record.

The snapshot is whole-tree rather than incremental from the write path: a manifest
workspace is small, and one shape is easier to reason about than a delta log whose
replay has to be correct. A cold pod re-downloads its module closure on resume;
only the workspace is checkpointed, never the cache.

**Changing the app set reuses this, because it has to.** A pod's container list is
fixed at creation — Kubernetes cannot add a container to a running pod — so
`PUT /v1/sessions/:id/apps` checkpoints, deletes the pod and creates one with the
new set, exactly as suspend + resume does. The alternatives were a pod per app
(which needs `ReadWriteMany` storage for the shared workspace), pre-allocated app
slots, or a supervisor process owning child kernels inside one container; all
three cost more than reusing a path that already exists.

The cost lands in the right place: editing a file stays free, and only changing
*which* applications run pays a pod recreate. That is a rare action, not a
per-keystroke one.

**Capacity changes shape.** Concurrency becomes bounded by simultaneous *editors*
rather than simultaneous *runs*. Model it before rollout; the current ceilings
were sized for the opposite assumption.

**Verify.** Detach every client, assert `status: suspended` within the idle window
and that the pod is gone; resume and assert the workspace contents match the last
checkpoint. Then restart the runner with a session suspended and assert resume
returns `404` — and that an editor meeting that `404` creates a session and
re-seeds its files in one change set, with no data loss visible to the user.

---

## Part 4 — Writes, and the reload trigger

Every write from outside the pod goes through the `workspace` container, proxied
by the runner:

| Route | Purpose |
| --- | --- |
| `GET /v1/sessions/:id/workspace` | Content-hash tree the editor diffs against its own files |
| `POST /v1/sessions/:id/workspace` | Apply a `{ write: [{path, content, encoding?}], delete: [path] }` change set |
| `GET /v1/sessions/:id/workspace/file?path=` | One file's contents |
| `POST /v1/sessions/:id/reload?app=<name>` | Re-run one app with no file change |
| `PUT /v1/sessions/:id/apps` | Change the running app set (checkpoint + pod recreate) |

The change-set shape is deliberate: an explicit write/delete list makes a deletion
expressible, which a whole-tree PUT cannot do without treating absence as intent —
and it is the shape the authoring agent's own workspace routes already settled on.
A single-file *write* route is deliberately absent; a one-file save is a change set
of one, and a second write path would be a second set of concurrency rules.

`reload` exists because `--watch` reloads on change, and pressing Run again after
a one-shot app completed is not a change. It touches the named app's entry
manifest through the same path everything else uses, so it needs no signalling
into the container, no shared PID namespace, and no `exec` — **RBAC is unchanged**.
Omitting `app` reloads every app in the session.

**`/io` takes an app selector.** `GET /v1/sessions/:id/io?app=<name>` attaches to
that container's PTY; the parameter is required whenever the session runs more
than one app, since there is no defensible default among several terminals.

Because `workspace` is always present, a session with an agent and one without
differ in exactly one container, and these routes behave identically in both.

**A port-set change must never be silent.** Adding a `ports:` entry is as ordinary
an edit as adding an import, and a container may bind any port regardless of what
the pod spec declares — so without handling, the app listens and is simply
unreachable: no ingress, no error, no event. On every reload the runner re-reads
the app's declared port set from the workspace (the same shallow manifest parse it
already does to key a build), **patches the Service and Ingress live**, and emits
an `endpoints` event so the editor updates its links. No pod recreate: the pod's
`containerPort` list is documentation, and the Service and Ingress are what make a
port reachable. A port that cannot be routed — it collides with another app in the
session — is reported on the stream as an error against that app, never dropped.

**Verify.** Assert every route works identically with and without an agent; that
`reload` increments only the named app's `generation` with `trigger: "manual"`;
that `/io` without `app` is rejected on a multi-app session; and that adding a
`ports:` entry to a running app yields a reachable endpoint plus an `endpoints`
event, with no pod recreate.

---

## Development flows

### 1. Anonymous visitor, first session

```
POST /v1/sessions  { mode: "watch", agent: "authoring-agent", bundle: {…} }
  → 201 { sessionId: "s_7f3a", streamUrl: "/v1/sessions/s_7f3a/events" }

GET /v1/sessions/s_7f3a/events
  progress { phase: "provision", message: "Scheduling" }
  progress { phase: "provision", message: "Pulling image" }
  progress { phase: "boot",      message: "Resolving 6 modules" }
  progress { phase: "boot",      message: "Booting" }
  status   { kind: "running" }
  run      { app: "app", generation: 1, phase: "started", trigger: "initial" }

GET /v1/sessions/s_7f3a/io?app=app          ← byte channel, separate transport
  { stream: "tty" }  "listening on :3000"
```

No `apps` in the request, so the session runs one app named `app` on the bundle's
own entry, under the default `io: "tty"`. No build: the pod pays schedule + pull +
one download of the closure into `/telo-cache/app`, which every later reload in
this session reuses.

### 2. Agent edits a resource body — the zero-cost case

The agent calls its own write tool against `/workspace/telo.yaml`. Nothing crosses
the pod boundary.

```
  run    { app: "app", generation: 1, phase: "completed", code: 0 }
  run    { app: "app", generation: 2, phase: "started", trigger: "watch" }
```

Elapsed: one kernel reload. No pod, no pull, no fetch, no build.

### 3. Agent adds an import

`imports:` gains `Sql: oci://ghcr.io/telorun/sql@0.9.0#sha256-…`.

The app container fetches it into its own cache root. The layer is verified
against the pin, so the fetch is trusted by digest, not by transport. This is the
one reload that touches the network, the latency is attributable — the user just
typed the import — and a failure is an error on the stream, not a stall. Every
subsequent reload resolves it from disk.

```
  run    { app: "app", generation: 3, phase: "started", trigger: "watch" }
  debug  { app: "app", record: { severity: "info", message: "resolving oci://ghcr.io/telorun/sql@0.9.0" } }
  run    { app: "app", generation: 3, phase: "failed", reason: "ERR_MODULE_UNREACHABLE" }
  status { kind: "running" }
```

The session survives a failed reload. That is the point.

### 4. User edits YAML in the editor

Editor saves → `POST /v1/sessions/:id/workspace` with a one-entry `write` change
set → the `workspace` container writes → the watcher reloads. Identical to flow 2
from the app's side; the only difference is who called the write.

### 5. Agent writes something broken, sees it, and fixes it

This is the capability that does not exist today.

```
  run   { app: "app", generation: 5, phase: "failed", reason: "ERR_MANIFEST_VALIDATION_FAILED" }
  debug { app: "app", record: { severity: "error", code: "CEL_UNKNOWN_FIELD",
                                path: "telo.yaml:14:3", message: "unknown field 'porrt' on 'ports'" } }
```

The diagnostic arrives as a **structured record**, not a line of terminal output —
so the agent branches on `code` instead of parsing bytes that interleave with the
app's own writes. This is what makes the read reliable rather than best-effort.

The agent reads the same stream, sees the diagnostic against the file it just
wrote, and edits again — generation 6. Today it would have to infer this from
`telo check` and could never see a runtime failure at all.

### 6. Agent verifies against the running app

The app serves HTTP on `:3000`; the workspace container reaches it on localhost.
The agent issues its own request and reads the real response — the difference
between "the manifest type-checks" and "the app works".

### 7. One-shot Runnable, then re-run

```
  run    { app: "app", generation: 2, phase: "completed", code: 0 }
  status { kind: "running" }          ← session alive, nothing evicted

POST /v1/sessions/s_7f3a/reload?app=app
  run    { app: "app", generation: 3, phase: "started", trigger: "manual" }
```

Under today's contract, generation 2 completing would be terminal and the next
run would be a new pod.

### 8. Idle, suspend, resume

```
(last editor tab closes)
  … 300s …
  status { kind: "suspended" }        ← pod deleted, checkpoint held

POST /v1/sessions/s_7f3a/resume
  progress { phase: "provision", message: "Scheduling" }
  status   { kind: "running" }
  run      { app: "app", generation: 4, phase: "started", trigger: "resume" }
```

Workspace contents match the last checkpoint; `generation` continues.

### 9. Two applications in one workspace

An API and a background worker, both under `--watch`, one agent editing both.

```
POST /v1/sessions  { mode: "watch", agent: "authoring-agent", apps: [
    { name: "web",    entryRelativePath: "telo.yaml",  ports: [{ port: 3000, protocol: "tcp" }] },
    { name: "worker", entryRelativePath: "worker.yaml" } ] }

  status { kind: "running" }
  run    { app: "web",    generation: 1, phase: "started", trigger: "initial" }
  run    { app: "worker", generation: 1, phase: "started", trigger: "initial" }
```

The agent edits a file only `worker.yaml` imports. One container reloads:

```
  run    { app: "worker", generation: 1, phase: "completed", code: 0 }
  run    { app: "worker", generation: 2, phase: "started", trigger: "watch" }
```

`web` is untouched and keeps serving on its stable session host — its generation
stays at 1. Both apps share the workspace, so the agent sees both streams and can
edit a library both import; each container reloads on its own watcher.

Two apps declaring port 3000 would have been `400 port_conflict` at create.

### 10. Adding a third application

```
PUT /v1/sessions/s_7f3a/apps  { apps: [ …web, …worker, { name: "admin", … } ] }
  status { kind: "suspended" }        ← checkpoint taken, pod deleted
  status { kind: "starting" }
  status { kind: "running" }
  run    { app: "web",    generation: 1, phase: "started", trigger: "resume" }
  run    { app: "worker", generation: 1, phase: "started", trigger: "resume" }
  run    { app: "admin",  generation: 1, phase: "started", trigger: "initial" }
```

A pod recreate, because a pod's container list is fixed at creation. Generations
restart with the new pod; the workspace comes back from the checkpoint. This is
the only editing action in the plan that costs a pod, and it is one the user takes
rarely.

### 11. An app starts listening on a new port

The agent adds a `ports:` entry to `worker.yaml`.

```
  run       { app: "worker", generation: 3, phase: "started", trigger: "watch" }
  endpoints { app: "worker", added: [{ port: 4000, url: "https://4000-s_7f3a.…" }] }
```

The runner re-read the declared port set on reload and patched the Service and
Ingress. Without this the app binds 4000 inside the pod and is unreachable with no
ingress, no error and no event — the one outcome worth designing against.

### 12. The same app, both ways

The user is debugging why log output looks wrong in production. Under the default
terminal mode, one merged stream with color:

```
GET /v1/sessions/s_7f3a/io?app=web
  { stream: "tty" }  "\e[32mINFO\e[0m  request handled"
  { stream: "tty" }  "\e[31mERROR\e[0m unreachable upstream"
```

They flip that app to `io: "streams"` and reload the session:

```
GET /v1/sessions/s_7f3a/io?app=web
  { stream: "stdout" }  "INFO  request handled"
  { stream: "stderr" }  "ERROR unreachable upstream"
```

Two things changed, and both are the point: the streams are separated at the
source, and the color is gone because `FORCE_COLOR` is not injected in this mode.
That second difference is what the app itself sees — it is the production
behaviour the terminal mode was hiding. Resize is rejected on this attachment.

### 13. Watch session without an agent

`{ mode: "watch" }` with no `agent`. The `workspace` container is present as
always and the editor drives every write, so the session differs by exactly one
container. Flows 4, 7, 8, 9, 10, 11 and 12 are unchanged; flows 2, 5 and 6 do not
apply.

### 14. Today's behaviour, unchanged

`POST /v1/sessions` with no `mode` is a run session: one pod, terminal on exit,
body-fetch init, baked cache. Nothing about it changes, which is what keeps this
landable incrementally.

---

## What this deletes

- The separate agent session for editor-driven authoring (`POST /v1/apps/authoring-agent/sessions` stays for standalone agent use).
- The body-fetch init container for watch sessions.
- The per-edit session-create round trip.
- The bundle-revision push channel that a watch design would otherwise need — the `workspace` container is the write path.
- The second workspace implementation an agentless watch session would otherwise need: one runner-owned image serves both cases.
- The unemitted `RunEvent` `stdout` / `stderr` variants, and the docker-runner README line claiming the SSE stream carries them.

## Correction to an earlier position

An earlier sketch argued the session pod could keep workload-only egress and pull
code through a runner-side verifying mirror. Co-location weakens that: the agent
needs egress to its model provider, and NetworkPolicy is per-pod, so every app
container inherits reachability to it. No credential leaks — the key stays in the
`workspace` container's env — but "deny anonymous workload egress entirely" is off
the table unless model calls are also proxied through the runner. A pull-through
module mirror stays available as an operator-side answer to bandwidth, and is not
a prerequisite for anything here.

## Risks

- **`exited` semantics are a contract change** with reach into the editor's status
  chip, the session registry's eviction scheduling, and any client that treats
  `exited` as end-of-stream. Largest ripple in the plan.
- **First-boot resolve latency is unmeasured**, and it is the only cost this plan
  does not remove — every session pays it once. It differs sharply by closure:
  bundled OCI modules are a handful of digest-addressed blob fetches, while a
  closure touching one of the deferred `pkg:npm` modules pays a real npm install
  with lifecycle scripts. Measure both; if the second dominates, the answer is to
  bundle those modules, not to reintroduce a cache tier.
- **Egress allowlist widens** to the session namespace, where CIDR-only policy
  cannot express it.
- **Capacity model inverts** from concurrent runs to concurrent editors.
- **Two writers plus N watchers** on one directory. The agent turn lock covers
  agent-versus-editor; a reload landing mid-write is bounded by writing through
  one surface, not by the lock. With several apps a single write can reload more
  than one of them at once — correct, but it makes a mid-write reload visible in
  several places instead of one.
- **The `app` qualifier has to land with the `run` event**, not after it.
  Retrofitting a field onto events clients already parse costs far more than
  shipping it unused in a single-app session.
- **A suspended session is best-effort by design**, so the editor being the
  authoritative copy is a requirement on the editor, not an observation about it.
  If a client ever drives a watch session without holding the workspace itself,
  that client loses work on a runner restart and nothing in the runner prevents it.
- **Live-patching the Service and Ingress on a port-set change** puts a manifest
  read on the reload path. A manifest the runner cannot parse must leave the
  existing routing in place and report, never tear it down.
- **Two attach paths per backend.** `io` doubles the attach code in both the
  Docker and Kubernetes backends and makes `/io` semantics mode-dependent, so a
  client attached to a `streams` app has to drop resize. Contained to the
  backends and the terminal component, but it is the one place this plan adds a
  branch rather than removing one.
- **Shared GID** is the kind of detail that fails as a confusing "file not found"
  one reload after the write.

## Non-goals

- Hot reload without a kernel restart. `--watch` restarts the kernel; services are
  torn down and ports rebound. That is much cheaper than a pod and is not
  instantaneous.
- Cross-session workspace persistence (accounts, named projects). A checkpoint
  survives a pod, not a runner restart — and durable storage for one is only worth
  building once there is an identity to reattach it to.
- Retiring the on-cluster image build. Run sessions keep it unchanged; watch
  sessions never reach it.

## Docs

- `apps/k8s-runner/README.md` — watch sessions, the new env surface, the two-container pod, suspend/resume.
- `apps/docker-runner/README.md` — the same session model; its workspace container is a sibling container and its cache roots are volumes, so every part applies unchanged. Its API section currently claims the SSE stream carries `stdout` / `stderr` events; correct that to the byte channel and its `stream` tag.
- `apps/authoring-agent/README.md` — the workspace is now the session's shared volume, written through the agent's own filesystem tools; the agent can observe a running app, and no longer serves the editor's workspace routes.
