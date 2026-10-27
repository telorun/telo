# @telorun/docker-runner

HTTP service that runs Telo Applications in Docker containers on the host daemon. A backend over [`@telorun/runner-core`](../../packages/runner-core), sibling to [`k8s-runner`](../k8s-runner): it presents the identical `/v1` session contract — the routes, events, ownership and lifecycle are runner-core's and documented in its README — and runs each session as sibling containers on the daemon whose socket it holds.

For running applications on your own machine with no daemon at all, `telo runner` serves the same API over local processes — no isolation and no terminal, but nothing to install. This runner is the one to reach for when a run should behave the way production does: an image, a container, published ports.

## How it works

**A session is a workspace.** Its record lives in the runner's session store and its files live in a directory of its own on the shared bundle volume; its containers are the part that comes and goes. Opening a workspace (`POST /v1/sessions`) creates a `workspace` container serving the editor's file routes, one idle `app-<name>` container per application, and optionally a co-resident `agent` configured by the `AGENT_*` variables. **Nothing runs until Run**: `POST /v1/sessions/:id/apps/:app/run` is a process start inside a container that already exists, under `telo run --watch`, so an edit costs a kernel reload rather than a container.

Because the runner lives in a container and starts other containers on the host daemon, a session's files must live where both see them: a named Docker volume mounted at `/bundles` in the runner (`BUNDLE_VOLUME`), whose subdirectories each session container mounts.

### The containers

Every container is named `telo-run-<sessionId>-<role>`, joins `RUNNER_CHILD_NETWORK`, and carries the labels `telo.run/session-id=<sessionId>` and `telo.run/role` (`workspace`, `app` — with `telo.run/app=<name>` and `telo.run/supervisor-build` — or `agent`). The runner finds a session's containers by the label, never by name, and reaches each at its address on the child network.

| Container | Image | Runs | Mounts | Env |
| --- | --- | --- | --- | --- |
| `workspace` | The runner's own kernel (`RUNNER_IMAGE`) | The runner's workspace manifest, on port 8099 | The whole bundle volume at `/srv` | `PORT`, `WORKSPACE_DIR`, `TELO_CACHE_DIR` |
| `app-<name>` | The app's telo version (`RUNNER_TELO_IMAGE_*`), else the session's picked image | `/opt/telo-runner/supervisor`, idle until Run | `<sessionId>/workspace` at `/workspace`; the supervisor build read-only at `/opt/telo-runner` | `TELO_SUPERVISOR_LISTEN`, `TELO_SUPERVISOR_TOKEN` only |
| `agent` | `AGENT_IMAGE`, or the runner's kernel image running `telo run` on `AGENT_MODULE_REF` | Its own entry point, or `telo run` | `<sessionId>/workspace` at `/workspace`; `<sessionId>/agent` at `/var/lib/telo-agent-state` | The operator's env from `AGENT_ENV`, `WORKSPACE_DIR`, `TELO_HOST_STATE_DIR=/var/lib/telo-agent-state` |

**No session env reaches any container definition.** A run's env arrives with the Run, is handed to the app's supervisor, and lives only in the process it starts — so it never appears in `docker inspect`. The operator env goes on the `agent` alone; `workspace` gets neither.

**The workspace is `/workspace`, exactly as on kubernetes.** App and agent containers mount only their own session's `workspace` subdirectory (`Subpath`), so a manifest is `/workspace/telo.yaml` on both backends, no session id appears in a path a workload sees, and one session cannot read another's files on disk. Only the runner's own `workspace` container mounts the volume whole, because its manifest and module cache sit beside the workspace it serves — which is also what keeps them out of the user's file tree.

**One cache for the whole session.** The runner seeds `telo-workspace.yaml` at the workspace root when the session's containers come up, and the kernel anchors its `.telo` cache at the directory holding that marker — on the session's directory, so a resumed session starts warm. App runs carry no `TELO_CACHE_DIR`, because that variable outranks the marker.

### Running an app: the session supervisor

Every `app-<name>` container's main process is the **session supervisor**, a static executable built by this runner's own release ([`packages/runner-core/supervisor`](../../packages/runner-core/supervisor), protocol [`specs/supervisor-protocol.md`](../../packages/runner-core/specs/supervisor-protocol.md)). It depends on nothing in the app image: no shell, no libc, no Node.

**Delivery.** The runner's image carries it at `/opt/telo-runner/supervisor`. At boot the runner writes it onto the bundle volume under `.supervisor/<build>/supervisor`, `<build>` being the first 16 hex digits of its SHA-256, and every app container mounts that directory read-only at `/opt/telo-runner` through `Subpath`, its `Entrypoint` replaced by `/opt/telo-runner/supervisor` so the supervisor is PID 1. A runner of another build writes a directory of its own rather than overwriting one an adopted container still runs; the orphan sweep removes a build no remaining container names in `telo.run/supervisor-build`.

**The container.** No TTY, no stdin, no session env, no shell: its stdout and stderr carry the supervisor's own log. It carries `TELO_SUPERVISOR_LISTEN=0.0.0.0:<9330 + position>` and a `TELO_SUPERVISOR_TOKEN` minted per container, which the supervisor removes from its environment before it starts anything. **The container's own definition is the token's durable home** — the store holds no secret, so an adopting runner reads each token back with `docker inspect`, and the agent's `tokenEnv` value likewise.

**A Run.** The runner holds one WebSocket per app container to `ws://<container address>:<9330 + position>/v1/supervisor` and sends it `telo run --watch --no-input --inspect 0.0.0.0:<9230 + position> --no-open <entry>` with the Run's env and `io`; the supervisor starts it in a process group of its own, with a fresh pty under `tty` and separate pipes under `streams`, and Stop is SIGTERM to the group, then SIGKILL after the grace period.

**Ports are reserved by position**, as on kubernetes: each app's supervisor port (`9330 + position`) and kernel debug port (`9230 + position`). An app set declaring one is refused (`400 port_conflict`, naming what binds it), and a reload declaring one is `rejected` on the `endpoints` event.

**A container that ends is the session's failure, never a run's**: the workspace, an app container (its supervisor) or the agent exiting, or a supervisor connection ending for good, reports `failed` naming the container; the runner removes what is left and `resume` rebuilds it over the same directory. Containers are created without `AutoRemove`, so an ended container keeps its exit code until the runner removes it.

### Suspend, resume and storage

A session's directory on the bundle volume, `<sessionId>/`, holds `workspace/` (the user's files and the module cache), `agent/` (the co-resident agent's state, outside the workspace tree so nothing syncs it), and the workspace application's manifest and cache. **Suspend removes the containers and keeps the directory**; resume creates them again over it, under the same session id, with every app `ready`. Deleting a session, or retention purging a suspended one (`RUNNER_SESSION_RETENTION_SECONDS`), removes both.

An app-set change (`PUT …/apps`) that changes what the containers are built from replaces the app containers and keeps the `workspace` and `agent` containers; changing the agent (`PUT …/agent`) replaces the agent container. Either ends every live run, and each app reports `ready` again.

### Restarting the runner

Session containers outlive the runner. At boot the runner loads every stored session and, for one stored as running, **adopts** its containers by the session label: it reads each supervisor token (and the agent's token) back from the container's definition, reconnects every supervisor, and reports each app as it stands — `running` with its live run included, which Stop can then end.

- Containers that are not the stored session's — another app set, another agent, one not started, or session supervisors of **another protocol generation** (containers older than this runner build) — are removed and the session becomes `suspended`, its directory kept; the editor's `resume` builds current ones.
- A container that has **ended** fails the session, naming it.
- Then the **orphan sweep** removes every container of a session that is not running here (its workload's, those it started through its engine, and any `telo-run-*` container of a runner from before the session label), every session directory the store does not know, and every supervisor build nothing mounts. A suspended session's directory is never touched.

Closing the runner detaches from its sessions and stops nothing.

### Docker 26 or newer

**The runner refuses to boot on a daemon older than Engine API 1.45 (Docker 26)**, naming the requirement, and on one it cannot ask for its version. Scoping a volume mount to a subdirectory (`Subpath`) arrived there, and every session's app and agent containers mount their own directories and the supervisor that way; an older daemon ignores the field and would mount the whole volume — every session's files in every container, at a path that looks correct.

## Required environment

The runner exits with a descriptive error if any of these is unset.

- **`BUNDLE_VOLUME`** — the daemon-visible name of the Docker volume mounted at `/bundles` in this runner, which session containers mount subdirectories of. In a compose deployment the name is prefixed by the project name (a compose-level key `runner-bundles` under `name: telo` resolves to `telo_runner-bundles`).
- **`RUNNER_CHILD_NETWORK`** — the Docker network session containers join, which the runner must be on too: it reaches every container at its address there. In compose this is typically `<project>_default`; standalone deployments set this to `bridge`.
- **`RUNNER_STATE_DIR`** — with the default SQLite session store: the runner's own state directory, on a persistent volume (compose: the `runner-state` volume at `/var/lib/telo-runner`); holds `sessions.sqlite`.

Optional, with defaults:

| Env var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8061` | HTTP listen port |
| `BUNDLE_ROOT` | `/bundles` | Path inside the runner where the bundle volume is mounted |
| `RUNNER_PUBLIC_BASE_URL` | _(unset)_ | Base URL of a host-matching proxy that fronts session containers by name (see [Reaching a session](#reaching-a-session)); unset, declared ports are published to the same host port |
| `RUNNER_TELO_IMAGE_REPOSITORY` | `telorun/node` | Where the kernel image of a telo version an application names is pulled from: `<repository>:<version>-<variant>` |
| `RUNNER_TELO_IMAGE_VARIANT` | `slim` | The variant suffix of that image tag |
| `RUNNER_TELO_UNRELEASED_IMAGE` | _(unset → refused)_ | The kernel image an unreleased build identity (`X+unreleased`) runs on — for a development stack whose editor is built from the same tree |
| `RUNNER_PULL_POLICY` | `missing` | How the runner pulls every image it chooses itself — a telo version's and its own workspace container's: `missing`, `always` or `never` (a host with its images preloaded) |
| `RUNNER_IMAGE` | `telorun/node:0-slim` | The kernel image the runner's own `workspace` container runs on |
| `LOG_LEVEL` | `info` | Pino log level |
| `RUNNER_MAX_SESSIONS` | `8` | Most running sessions at once; suspended ones do not count |
| `RUNNER_SESSION_STORE` | `sqlite` | Where session records are kept: `sqlite` (a file in `RUNNER_STATE_DIR`) or `postgres`. Anything else refuses to boot |
| `RUNNER_SESSION_STORE_URL` | _(unset)_ | The Postgres connection URL; required with `postgres`, refused with `sqlite` |
| `RUNNER_REPLAY_BUFFER_BYTES` | `5000000` | Per-session SSE replay buffer cap |
| `RUNNER_SESSION_IDLE_SECONDS` | `300` | No SSE/WS subscriber for this long → suspend (containers removed, directory kept) |
| `RUNNER_SESSION_MAX_RUNNING_SECONDS` | `21600` | A running session suspends after this long |
| `RUNNER_SESSION_RETENTION_SECONDS` | `2592000` | A suspended session is deleted with its directory after this long — 30 days |
| `RUNNER_SESSION_RELOAD_LIMIT` | `30` | Per-session reloads per minute |
| `RUNNER_IDENTITY_AUDIENCE` / `RUNNER_IDENTITY_ISSUERS` | _(unset → resume secrets only)_ | Signed-in owners — see runner-core's README, § Identity |
| `RUNNER_CORS_ORIGINS` | `*` | Comma-separated origins the runner serves |
| `RUNNER_TERMS_FILE` | _(unset)_ | Path to the agreement file (plain text / markdown), read at startup — the natural fit for a bind-mounted file. Setting this (or `RUNNER_TERMS_BODY`) enables terms: the runner advertises them on `/v1/capabilities` and rejects `POST /v1/sessions` with `428` unless the client sends `x-telo-accepted-terms` matching the version. An unreadable path fails startup |
| `RUNNER_TERMS_BODY` | _(unset)_ | Inline agreement text, for short notes; ignored when `RUNNER_TERMS_FILE` is set. Terms stay disabled unless one of these is set |
| `RUNNER_TERMS_TITLE` | `Usage agreement` | Heading shown above the agreement |
| `RUNNER_TERMS_VERSION` | _(hash of body)_ | Acceptance version; defaults to a content hash so any edit to the body automatically re-prompts every client. Set explicitly only to control material-change vs typo |
| `RUNNER_SESSION_CONTAINERS` | `false` (`true` in compose) | Serve every session a container engine of its own — see [Session containers](#session-containers) |
| `RUNNER_SESSION_CONTAINERS_MAX` | `4` | Most containers one session may hold at once; a create beyond it is `429` |
| `RUNNER_INTERNAL_URL` | _(required when containers are on)_ | The runner as a session's container reaches it over `RUNNER_CHILD_NETWORK` (compose: `http://runner:8061`); the runner refuses to boot without it |
| `AGENT_IMAGE` / `AGENT_MODULE_REF` | _(unset → no agent)_ | The operator's co-resident agent, offered as a session's `agent` (`features.agents`, named `authoring-agent`). Set exactly one source: `AGENT_IMAGE` runs a container image on its own entry point; `AGENT_MODULE_REF` runs `telo run` on a module with the runner's kernel image — an `oci://` reference fetched at start, or an absolute host path bind-mounted read-only. `AGENT_PORT` is required: the tcp port the agent listens on. Companions: `AGENT_ENV` (a JSON object of plain env, may embed secrets; only names are advertised), `AGENT_PULL_POLICY` (image only), `AGENT_TOKEN_ENV` (an env var the runner fills with a per-session token it reports as `token` on `status.agent`, see [Workload tokens](#workload-tokens); naming a key `AGENT_ENV` also sets is a startup error), `AGENT_TITLE`, `AGENT_DESCRIPTION`. Both sources, or companions without a source, is a startup error. `RUNNER_APPS` is retired and refuses startup. Treat the `AGENT_*` values as secret material. Example: `AGENT_MODULE_REF=oci://ghcr.io/telorun/authoring-agent@<version> AGENT_PORT=8080 AGENT_TOKEN_ENV=AGENT_TOKEN AGENT_ENV='{"ANTHROPIC_API_KEY":"<key>"}'` |

A runner started with a variable this release no longer reads refuses to boot, naming each one: `RUNNER_WATCH_MAX_SESSIONS`, `RUNNER_WATCH_IDLE_SECONDS`, `RUNNER_WATCH_MAX_TTL_SECONDS`, `RUNNER_WATCH_SUSPENDED_TTL_SECONDS` and `RUNNER_WATCH_RELOAD_LIMIT` are renamed to `RUNNER_MAX_SESSIONS`, `RUNNER_SESSION_IDLE_SECONDS`, `RUNNER_SESSION_MAX_RUNNING_SECONDS`, `RUNNER_SESSION_RETENTION_SECONDS` and `RUNNER_SESSION_RELOAD_LIMIT`; `RUNNER_WATCH_SESSIONS`, `RUNNER_WORKSPACE_CHECKPOINT_SECONDS`, `RUNNER_EXIT_TTL_MS`, `RUNNER_MAX_TTL_SECONDS` and `RUNNER_APP_MAX_TTL_SECONDS` are removed.

## Standalone

```bash
docker volume create telo-runner-bundles
docker volume create telo-runner-state
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v telo-runner-bundles:/bundles \
  -v telo-runner-state:/var/lib/telo-runner \
  -e BUNDLE_VOLUME=telo-runner-bundles \
  -e RUNNER_STATE_DIR=/var/lib/telo-runner \
  -e RUNNER_CHILD_NETWORK=bridge \
  -p 127.0.0.1:8061:8061 \
  telorun/docker-runner
```

Point an editor at `http://localhost:8061`.

### Security posture

Sessions are owned — a resume secret, or a DPoP-bound identity on a runner configured for one — but the API is backed by host Docker socket access: anyone who can create a session can start containers on the host daemon. **Default bind is `127.0.0.1`**; exposing `0.0.0.0` is reserved for networks the operator has independently decided to trust.

**Trust boundary: sessions are mutually trusted on this runner.** Every session container joins one `RUNNER_CHILD_NETWORK`, and each session's workspace API answers at its `workspace` container's address on port 8099 with no auth — so any session's workload can read and WRITE another session's workspace over the network, whatever it can see on disk. A supervisor port takes only its own container's token, so one app cannot drive another's runs. Do not deploy this runner expecting isolation between sessions; the kubernetes runner is the multi-tenant one.

## Compose

The repo's [docker-compose.yml](../../docker-compose.yml) wires the runner alongside the editor on the `development` stage, which runs this checkout's sources and carries the session supervisor built from it (rebuild with `docker compose build runner` after changing the supervisor). `pnpm compose up` brings it up; the editor reaches it through the proxy at `http://runner.telo.localhost:8060`.

## Reaching a session

**Without a proxy** (`RUNNER_PUBLIC_BASE_URL` unset) every declared port is published to the same host port, and endpoints carry an empty `host` the client fills from the base URL it reached the runner on. A port's bindings are fixed when its container is created, so a port a reload adds is reported `rejected` until the app set changes or the session resumes.

**Behind a proxy** (`RUNNER_PUBLIC_BASE_URL` set) nothing is published; each tcp port is announced as `<port>-<sessionId>.<base-domain>`, which the proxy splits back into `telo-run-<sessionId>:<port>` — a network alias the one app declaring ports takes. With several port-declaring apps the name would be ambiguous (docker round-robins a shared alias), so nothing takes it and every such port is reported `rejected`. A port a reload adds is routable once something binds it.

### Reaching the co-resident agent

The `running` status carries an `agent` endpoint beside `endpoints`, and `AGENT_PORT` is required: a runner without one refuses to start. Where an application declares the agent's port, the **manifest wins** on a create: the session starts without the agent and says so on its stream.

Behind a proxy the agent takes its **own** network alias, `telo-run-<sessionId>-agent`, reachable at `<agentPort>-<sessionId>-agent.<base-domain>` with no proxy configuration — the session label is the proxy's trailing capture. Giving it the session's alias instead would make every app port a coin flip. With no proxy the agent's port is published to the host like an app's.

**Nothing verifies that the agent listens where `port` says.** `port` tells the runner where to route; what the image binds is configured separately (the authoring agent reads `PORT`, defaulting to 8080). Keep `port` and any `PORT` in the entry's `env` in agreement.

### Workload tokens

An agent with `AGENT_TOKEN_ENV` set gets a token per container creation (create, resume, agent change): core mints it, the runner injects it into the agent container under `tokenEnv`, and core reports the same value as `token` on `status.agent`. A client presents it to the agent — typically as `Authorization: Bearer <token>` to an image that compares it with the env var. An adopted session keeps the token its container was created with, read back from it.

## Session containers

With `RUNNER_SESSION_CONTAINERS=true` every Run gets `TELO_HOST_CONTAINER_ENGINE_URL` (`<RUNNER_INTERNAL_URL>/v1/sessions/<id>/engine`) and `TELO_HOST_CONTAINER_ENGINE_TOKEN`, so a test that starts its own database through `Docker.Engine` runs in a session exactly as it runs locally. No socket reaches the session: the runner answers the Engine API requests `Docker.Engine` sends behind the session's token (the contract, refusals and ceiling are `@telorun/runner-core`'s, in its README) and runs each container as a sibling on the host daemon:

- joined to `RUNNER_CHILD_NETWORK`, where the session's app container reaches it;
- labelled `run.telo.session=<id>`, never named after the session, so the proxy that fronts `telo-run-<id>` never routes to it;
- publishing nothing on the host — inspect answers each requested binding with the container's address on `RUNNER_CHILD_NETWORK` and its container port;
- removed with its volumes when the session's run ends, the session suspends, fails or is deleted, and at boot when its session is not running here.

`node scripts/runner-containers-e2e.mjs` drives a whole session against the runner's `production` image, on a network and volumes of its own, writing nothing in the checkout: create, seed the workspace with a container-backed integration test, Run it to exit code 0, Stop, suspend, resume, delete — failing if the test leaves a container behind or the session leaves anything.

## The telo version an application runs on

Each application of a session may name the telo version it runs on (`telo`, on each entry of `apps`) — the version the editor checks that module against. The runner advertises `features.teloVersions` and runs that application's container on `<RUNNER_TELO_IMAGE_REPOSITORY>:<version>-<RUNNER_TELO_IMAGE_VARIANT>` (`telorun/node:0.123.0-slim` by default), pulled under the operator's `RUNNER_PULL_POLICY` while the session's containers are created, with progress on its event stream; one that cannot be pulled, or is not held under `never`, fails that session with the daemon's answer. Never a substitute. A release older than 0.123.0, the oldest a runner is verified to supervise, is refused when the app set is created or replaced (`400 telo_version_unavailable`).

An unreleased build (`0.123.0+unreleased`, what an editor built from an unreleased tree asks for) has no published image. Set `RUNNER_TELO_UNRELEASED_IMAGE` to a kernel image built from that same tree and it runs on that; unset, the app set is refused (`400 telo_version_unavailable`) with a reason naming the variable.

The runner's own `workspace` container does not follow the application's version: it runs on `RUNNER_IMAGE` (default `telorun/node:0-slim`), the kernel the runner's own manifest is verified against.

`config.image` and `config.pullPolicy` are **deprecated**: they are what a client naming no version still sends, and they choose the app containers' image for that client. A request naming a version beside either is `400 invalid_config`, and a session's applications either all name a version or none does.

## `io` — terminal or separated streams

Each Run chooses `io: "tty"` or `io: "streams"`, and the difference is observable **to the application**: `isatty()` drives colour, buffering, progress bars and prompts. Under `tty` the supervisor gives the run a fresh pty (and `CLICOLOR_FORCE`); under `streams` its stdout and stderr stay separate pipes. Changing it changes nothing about the containers.

## Development

```bash
pnpm --filter @telorun/docker-runner dev     # tsx watch
pnpm --filter @telorun/docker-runner test    # vitest
pnpm --filter @telorun/docker-runner build   # tsc
```

The runner needs its image's session supervisor and a daemon-visible bundle volume, so end-to-end use requires the compose or standalone deployment above. The tests drive the backend over a fake engine (`src/docker/fake-engine.test-support.ts`): containers that come up on loopback addresses of their own, with a workspace surface and a supervisor speaking the protocol (runner-core's `FakeSupervisor`, from `@telorun/runner-core/test-support`).
