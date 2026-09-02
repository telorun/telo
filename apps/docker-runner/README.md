# @telorun/docker-runner

HTTP service that runs Telo Applications in Docker containers on the host daemon. Exposes `/v1/sessions`, `/v1/probe`, and `/v1/health` so the Telo editor (or any compatible client) can start, stop, and stream runs without itself having Docker access.

## How it works

The runner binds the host Docker socket (`/var/run/docker.sock`), receives bundle files over HTTP, writes them into a shared named volume, and spawns `telorun/node:latest-slim` (or any compatible image) as a sibling container on the host daemon. Logs stream back to the client via Server-Sent Events.

Because the runner lives in a container and spawns other containers on the host daemon, bundle files must live on a path visible to both the runner and the spawned containers. A named Docker volume mounted at `/bundles` inside the runner and `/srv` inside every spawn satisfies that.

## Required environment

Two variables are mandatory — the runner exits with a descriptive error if either is unset.

- **`BUNDLE_VOLUME`** — the daemon-visible name of a Docker volume mounted at `/bundles` in this runner. The runner passes this name to `Binds` when spawning sibling containers. In a compose deployment the name is prefixed by the project name (e.g. a compose-level key `runner-bundles` under `name: telo` resolves to `telo_runner-bundles`).
- **`RUNNER_CHILD_NETWORK`** — the Docker network name that spawned containers should join. In compose this is typically `<project>_default` so the spawned containers can reach sibling services by name. Standalone deployments set this to `bridge`.

Optional, with defaults:

| Env var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8061` | HTTP listen port |
| `BUNDLE_ROOT` | `/bundles` | Path inside the runner where bundles are written; must match the named-volume mount path |
| `LOG_LEVEL` | `info` | Pino log level |
| `RUNNER_MAX_SESSIONS` | `32` | Cap on retained sessions; at capacity the oldest exited session is evicted, and only an all-live runner rejects with 409 |
| `RUNNER_EXIT_TTL_MS` | `14400000` | How long exited sessions stay in the registry (so the editor can re-attach and replay their history after a reload) before eviction |
| `RUNNER_REPLAY_BUFFER_BYTES` | `5000000` | Per-session SSE replay buffer cap |
| `RUNNER_TERMS_FILE` | _(unset)_ | Path to the agreement file (plain text / markdown), read at startup — the natural fit for a bind-mounted file. Setting this (or `RUNNER_TERMS_BODY`) enables terms: the runner advertises them on `/v1/capabilities` and rejects `POST /v1/sessions` with `428` unless the client sends `x-telo-accepted-terms` matching the version. An unreadable path fails startup |
| `RUNNER_TERMS_BODY` | _(unset)_ | Inline agreement text, for short notes; ignored when `RUNNER_TERMS_FILE` is set. Terms stay disabled unless one of these is set |
| `RUNNER_TERMS_TITLE` | `Usage agreement` | Heading shown above the agreement |
| `RUNNER_TERMS_VERSION` | _(hash of body)_ | Acceptance version; defaults to a content hash so any edit to the body automatically re-prompts every client. Set explicitly only to control material-change vs typo |
| `RUNNER_WATCH_SESSIONS` | `false` (`true` in compose) | Server-side gate for watch sessions — never client-requestable when off |
| `RUNNER_WATCH_IDLE_SECONDS` | `300` | No SSE/WS subscriber for this long → suspend (containers deleted, workspace checkpoint held) |
| `RUNNER_WATCH_MAX_SESSIONS` | `8` | Concurrency ceiling for watch sessions, separate from `RUNNER_MAX_SESSIONS` |
| `RUNNER_WATCH_RELOAD_LIMIT` | `30` | Per-session reloads per minute |
| `RUNNER_WATCH_SUSPENDED_TTL_SECONDS` | `86400` | How long a suspended record is retained before eviction — bounds accumulation, and is not a workload deadline |
| `RUNNER_WORKSPACE_CHECKPOINT_SECONDS` | `30` | How often the runner pulls a whole-tree workspace snapshot |
| `RUNNER_APPS` | _(unset → no apps)_ | JSON map of operator-predefined apps launchable by name via `POST /v1/apps/:name/sessions`: `{"<name>": {"image", "env"?, "pullPolicy"?, "port"?, "title"?, "description"?}}`. `env` is injected verbatim into the app's workload and may embed secrets — clients can never set those keys, and only name/title/description are advertised on `/v1/capabilities`. `port` is the tcp port the image listens on; it is what the runner publishes when the entry is used as a session's co-resident `agent`, and there is no default, because the runner knows nothing about any specific app. Treat the whole value as secret material (it fits a `.env.local` file next to the runner). Example: `{"authoring-agent": {"image": "telorun/authoring-agent:latest-slim", "env": {"OPENAI_API_KEY": "sk-..."}, "pullPolicy": "always", "port": 8080}}` |

## Standalone

```bash
docker volume create telo-runner-bundles
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v telo-runner-bundles:/bundles \
  -e BUNDLE_VOLUME=telo-runner-bundles \
  -e RUNNER_CHILD_NETWORK=bridge \
  -p 127.0.0.1:8061:8061 \
  telorun/docker-runner
```

Point an editor at `http://localhost:8061`.

### Security posture

The runner has an unauthenticated HTTP API backed by host Docker socket access. Anyone who can reach `/v1/sessions` can start arbitrary containers as root on the host daemon. **Default bind is `127.0.0.1`**; exposing `0.0.0.0` is reserved for networks the operator has independently decided to trust. No auth is planned for v1.

## Compose

The repo's [docker-compose.yml](../../docker-compose.yml) already wires the runner alongside the editor. `pnpm compose up` brings it up. The editor service picks the runner URL from `VITE_TELO_RUNNER_URL=http://runner:8061` and waits for the runner's healthcheck before starting.

## API

### `GET /v1/health`

Liveness. `200 { ok: true, version }` regardless of daemon state. Use `/v1/probe` for daemon reachability.

### `GET /v1/capabilities`

The runner's self-description, so the editor renders a generic runner config form without hardcoding per-backend fields. `200 { displayName, description, config: { schema }, features: { io, ports } }` where `config.schema` is a JSON Schema for the editable `SessionConfig` fields (each property carries its own `default`). docker-runner advertises `image` / `pullPolicy` as editable (it trusts the caller to pick the image). `baseUrl` is never in this schema — the client owns it.

### `POST /v1/probe`

Body: `{ config: { image, pullPolicy } }`. Returns an `AvailabilityReport` — either `ready`, `needs-setup` with issues, or `unavailable` with a human-readable message and remediation. Staged checks run daemon → bundle volume → child network → image; first failing stage wins.

### `POST /v1/sessions`

Body: `{ bundle: { entryRelativePath, files: [{ relativePath, contents }] }, env: { KEY: VALUE, ... }, config: { image, pullPolicy } }`.

On success: `201 { sessionId, streamUrl, createdAt }`. Start is all-or-nothing up to `container.start()` — any failure returns non-2xx with `{ error, stage, message, daemonMessage? }`:

- `400 invalid_bundle` — bundle paths or shape rejected.
- `409 too_many_sessions` — concurrent session cap hit.
- `502 pull_failed` (`stage: "pull" | "inspect"`) — registry unreachable or image missing under `pullPolicy: "never"`.
- `503 start_failed` (`stage: "daemon" | "create" | "attach" | "start"`) — daemon-level failure.

### `POST /v1/apps/:name/sessions`

Creation door for operator-predefined applications (`RUNNER_APPS`). Body: `{ env?, ports?, inspect? }` — no bundle, no config; the runner resolves the image and injects the app's operator env from the catalog (client-supplied values for those keys are dropped). On success: `201 { sessionId, streamUrl, createdAt }` — the session lives in the same collection as bundle sessions (status / DELETE / events / io under `/v1/sessions/:id`). `404 unknown_app` when the catalog doesn't offer the name; the same terms gate (`428`) applies.

### `GET /v1/sessions/:id`

`200 { sessionId, status, mode, agent?, apps, createdAt, exitedAt? }` or `404`.
`apps` lists `{ name, io, generation, ports }` per running application.

### `DELETE /v1/sessions/:id`

Idempotent `204`. Kills the spawned container and marks the session as user-stopped; the terminal `status: stopped` event ships via SSE, not in this response.

### `GET /v1/sessions/:id/events`

SSE stream. Events: `status`, `progress`, `debug`, `reachability`, `run`, `endpoints`, and `gap` when the replay buffer has evicted events the client asked to resume from. Each event carries a monotonic `id`. Reconnects send `Last-Event-ID` (native) or `?lastEventId=<n>` (fresh instance, e.g. tab reload) — server prefers the header.

**Workload output does not travel this stream.** It goes over the byte channel (`/v1/sessions/:id/io`), which exists precisely because per-chunk events are wasteful for high-volume output. This section previously listed `stdout` and `stderr` events; nothing ever emitted them, and they are gone.

`status` is the SESSION's state, `run` is one application's outcome, and the two are deliberately separate nouns: in a watch session a one-shot app completing emits `run` with `phase: "completed"` and leaves the session `running`, so the next edit starts that app's next generation.

## Watch sessions

**The compose stack has these on** (`RUNNER_WATCH_SESSIONS: "true"` on the `runner` service) — a workspace that reloads on save is the point of running the dev stack. The default everywhere else is off, since a watch session is a container set that outlives its runs.

`POST /v1/sessions` with `mode: "watch"` makes the session a **workspace that runs continuously** rather than one run: a shared workspace directory, a `workspace` container serving the file routes below, one container per application running `telo run --watch`, and optionally a co-resident `agent` from the `RUNNER_APPS` catalog. An edit then costs a kernel reload instead of a container.

Docker's containers on the child network stand in for containers in a pod, and per-session directories on the shared bundle volume stand in for pod volumes. Everything else — the routes, the events, suspend/resume — is identical to the kubernetes runner's.

**The workspace is at `/workspace`, exactly as on kubernetes.** An application container and the agent mount only that session's own `workspace` subdirectory of the shared volume, at that path — so a manifest is `/workspace/telo.yaml` on both backends and no session id appears in any path a workload sees. The runner's own siblings of that directory (the file service's manifest, and its module cache) fall outside the mount, so a user's workspace listing shows only their files plus the marker.

Only the `workspace` container still mounts the volume whole, at `/srv`: it is the runner's own, and it needs its manifest and cache beside the workspace it serves.

**This needs Docker Engine API 1.45 (Docker 26) or newer**, which is where scoping a volume mount to a subdirectory arrived. An older daemon ignores the field and would mount the whole volume at `/workspace` — every session's files in every container, at a path that looks correct — so the runner probes the daemon at boot and **advertises `features.watch: false`** when it is too old, logging why. Run sessions are unaffected and keep their whole-volume `/srv` bind.

**One cache for the whole session.** The runner seeds `telo-workspace.yaml` at the workspace root when the session starts, and the kernel anchors its `.telo` cache at the directory holding that marker — so two apps importing the same module resolve it once between them. Application containers carry no `TELO_CACHE_DIR`, because that variable outranks the marker.

**Trust boundary: sessions are mutually trusted on this runner.** Every session
container joins one `RUNNER_CHILD_NETWORK`, and the workspace API is
name-addressable at `telo-run-<sessionId>-workspace:8099` with no auth — so any
session's workload can read and WRITE another session's workspace over the
network, whatever it can see on disk. Do not deploy this runner expecting
isolation between sessions; the kubernetes runner is the multi-tenant one.

On disk the exposure is narrower than it was: a watch session's application and
agent containers mount only their own workspace, so they cannot read another
session's files that way. A RUN session still binds the whole bundle volume at
`/srv` and can.

**Orphan reap.** A run session's container exits on its own and the daemon `--rm`s it; a watch session's containers do not, by design. So the runner removes every `telo-run-*` container at boot — a restart would otherwise leave a workspace, an agent and one container per app running with nothing able to reach them.

### Reaching the co-resident agent

An `agent` is only useful if a client can talk to it, so the runner publishes it
and reports where: the `running` status carries an `agent` endpoint beside
`endpoints`, and `POST /v1/sessions` refuses an agent whose catalog entry
declares no `port` (`400 agent_port_undeclared`) rather than starting one nobody
can reach. Where an application declares the agent's port, the **manifest wins**:
the session starts without the agent and reports it on the stream, rather than
refusing to run the user's app over a container they never asked for.

Behind a proxy the agent takes its **own** network alias,
`telo-run-<sessionId>-agent`, so it is reachable at
`<agentPort>-<sessionId>-agent.<base-domain>` with no proxy configuration — the
session label is the proxy's trailing capture, so the existing rule already
resolves it. Giving it the session's own alias instead would have made every app
port a coin flip, since docker round-robins a shared alias; that is the same
ambiguity a multi-app session has to refuse. With no proxy the port is published
to the host like an app's, and the client fills in the hostname it reached the
runner on.

The agent is the only container that receives the operator env, and it is
reachable without auth for as long as the session lives — the same exposure an
app session of the same image already has.
**Nothing verifies that the agent listens where `port` says.** `port` tells the
runner where to route; what the image actually binds is configured separately
(the authoring agent reads `PORT`, defaulting to 8080). If the two disagree the
runner publishes a port and routes a host with nothing behind it, and the agent
appears to start while every request to it fails — neither backend watches the
agent's port the way both watch an application's. Keep `port` and any `PORT` in
the entry's `env` in agreement.


| Route | Purpose |
| --- | --- |
| `GET /v1/sessions/:id/workspace` | Content-hash tree the editor diffs against its own files |
| `POST /v1/sessions/:id/workspace` | Apply a `{ write: [{path, content, encoding?}], delete: [path] }` change set |
| `GET /v1/sessions/:id/workspace/file?path=` | One file's contents |
| `POST /v1/sessions/:id/reload?app=<name>` | Re-run one app with no file change (omit `app` for all) |
| `PUT /v1/sessions/:id/apps` | Change the running app set (checkpoint + container recreate) |
| `POST /v1/sessions/:id/resume` | Bring a suspended session back under the same id |

A change set is an explicit write/delete list rather than a whole-tree PUT, because a deletion has to be expressible and a whole-tree PUT can only express it by treating absence as intent. There is deliberately no single-file write route: a one-file save is a change set of one, and a second write path would be a second set of concurrency rules.

**The editor holds the authoritative workspace; the checkpoint is a cache.** The runner is a single replica with an in-memory session registry, so a restart drops every suspended session and `resume` answers `404` — the editor creates a new session and re-seeds from its own copy in one change set.

### `io` — terminal or separated streams

Each app declares `io: "tty"` (default) or `io: "streams"`. The difference is observable **to the application**, not just to the client: `isatty()` drives colour, line-versus-block buffering, progress bars and prompts, so a loop that is always a PTY systematically hides how the app behaves in production.

| | `tty` | `streams` |
| --- | --- | --- |
| Output | One merged stream, as a terminal produces | Separated at the source |
| `/io` resize | Yes | Rejected — meaningless without a PTY |
| `CLICOLOR_FORCE` | Injected | **Not** injected |

Nothing is invented at the transport layer: docker's non-TTY attach already returns a multiplexed stream carrying a per-frame stream id. The TTY is what collapses it.

`GET /v1/sessions/:id/io?app=<name>` attaches to one app's channel; `?app=` is required whenever the session runs more than one, since there is no defensible default among several terminals. Every binary frame is `[seq:4 BE][stream:1][payload]`, where the stream byte is `tty` / `stdout` / `stderr` — it never asserts a split that does not exist.

## Hand-test recipe

```bash
# bring up the runner + its prerequisites
docker compose up -d runner

# sanity probe
curl -s http://localhost:8061/v1/health
curl -s -X POST http://localhost:8061/v1/probe \
  -H 'content-type: application/json' \
  -d '{"config":{"image":"telorun/node:latest-slim","pullPolicy":"missing"}}'

# start a one-file session that echoes and exits
curl -s -X POST http://localhost:8061/v1/sessions \
  -H 'content-type: application/json' \
  -d '{
    "bundle": {
      "entryRelativePath": "telo.yaml",
      "files": [{"relativePath":"telo.yaml","contents":"kind: Telo.Application\nmetadata:\n  name: hello\ntargets: [hello]\nresources:\n  - kind: Console.Log\n    name: hello\n    message: \"Hello from telo!\"\n"}]
    },
    "env": {},
    "config": {"image":"telorun/node:latest-slim","pullPolicy":"missing"}
  }'
# → { sessionId, streamUrl }

# stream the logs
curl -N http://localhost:8061/v1/sessions/<sessionId>/events
```

## Development

```bash
pnpm --filter @telorun/docker-runner dev     # tsx watch
pnpm --filter @telorun/docker-runner test    # vitest
pnpm --filter @telorun/docker-runner build   # tsc
```

The in-process dev server can't spawn sibling containers via a named-volume bind (the bundle dir is a host tmpdir, not a daemon-visible volume), so end-to-end testing requires the compose or standalone deployment above. Unit and route tests cover the runner logic with a fake dockerode.
