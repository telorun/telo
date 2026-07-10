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
| `RUNNER_APPS` | _(unset → no apps)_ | JSON map of operator-predefined apps launchable by name via `POST /v1/apps/:name/sessions`: `{"<name>": {"image", "env"?, "pullPolicy"?, "title"?, "description"?}}`. `env` is injected verbatim into the app's workload and may embed secrets — clients can never set those keys, and only name/title/description are advertised on `/v1/capabilities`. Treat the whole value as secret material (it fits a `.env.local` file next to the runner). Example: `{"authoring-agent": {"image": "telorun/authoring-agent:latest-slim", "env": {"OPENAI_API_KEY": "sk-..."}, "pullPolicy": "always"}}` |

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

The runner's self-description, so the editor renders a generic runner config form without hardcoding per-backend fields. `200 { displayName, description, config: { schema }, features: { io, ports } }` where `config.schema` is a JSON Schema for the editable `SessionConfig` fields (each property carries its own `default`). docker-runner advertises `image` / `pullPolicy` / `registryUrl` as editable (it trusts the caller to pick the image). `baseUrl` is never in this schema — the client owns it.

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

`200 { sessionId, status, createdAt, exitedAt? }` or `404`.

### `DELETE /v1/sessions/:id`

Idempotent `204`. Kills the spawned container and marks the session as user-stopped; the terminal `status: stopped` event ships via SSE, not in this response.

### `GET /v1/sessions/:id/events`

SSE stream. Events: `stdout`, `stderr`, `status`, and `gap` when the replay buffer has evicted events the client asked to resume from. Each event carries a monotonic `id`. Reconnects send `Last-Event-ID` (native) or `?lastEventId=<n>` (fresh instance, e.g. tab reload) — server prefers the header.

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
