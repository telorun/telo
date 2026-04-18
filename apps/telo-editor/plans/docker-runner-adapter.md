# Docker Runner Adapter

## Goal

Add a second `RunAdapter` that runs Applications via an HTTP service (`telo-runner`) which itself lives in a Docker container and spawns other Docker containers on the host daemon. Primary driver: make Run work from the editor when the editor is itself running in the repo's `docker-compose.yml` (where there is no Tauri host and no local `docker` CLI). The service also works standalone (`docker run …`) so it is not coupled to this repo's compose.

This plan assumes [run-adapters.md](./run-adapters.md) has landed: `RunAdapter`, `RunBundle`, `RunEvent`, `RunSession`, the registry, `RunContext`, and the schema-driven config form already exist. This plan only adds one new adapter and one new package.

## Non-goals

- Auth, TLS, multi-tenant isolation. v1 runs on a trusted network (compose bridge or LAN). Auth is a follow-up.
- Multi-session concurrency in the editor. `RunContext` is still one-at-a-time; the runner itself supports parallel sessions because that's cheaper than preventing it.
- Log persistence / replay across runner restarts. If the runner process dies mid-run, the spawned container is killed and the session is lost.
- stdin forwarding to the container.
- Kubernetes, ECS, Nomad. These are future adapters with the same shape.
- Running the runner inside the Tauri build. The desktop uses `tauri-docker`; this adapter is for browser-hosted editor and CI contexts.

---

## Principles

1. **Transport-agnostic types are already paid for.** `RunAdapter`, `AvailabilityReport`, and `RunEvent` are wire-shape-neutral by design. This adapter maps one-to-one onto HTTP + SSE with no shape divergence.
2. **The runner is a thin shell over the Docker Engine API.** No orchestration state, no DB. Session state lives in memory for the lifetime of one runner process.
3. **Bundle handoff is via a named volume, not HTTP upload then tar unpack.** The runner writes bundle files into a path that is simultaneously bind-mounted into spawned containers. This sidesteps the docker-in-docker path-translation problem and avoids a second copy.
4. **No privileged mode, no Docker-in-Docker image.** The runner gets access to the host daemon by bind-mounting `/var/run/docker.sock`. Spawned containers are siblings of the runner, not children — they come up on the host's daemon.
5. **One adapter, two deployment shapes.** `apps/docker-runner` ships one image. It runs inside this repo's compose next to the editor, and independently via `docker run`. Same image, same API, different compose wiring.

---

## Directory structure

```
apps/docker-runner/                       # new package
  package.json                            # { "name": "@telorun/docker-runner", private: true }
  tsconfig.json
  Dockerfile                              # multi-stage: development / production
  src/
    server.ts                             # Fastify app; wires routes, starts listener
    routes/
      sessions.ts                         # POST /v1/sessions, DELETE /v1/sessions/:id, GET /v1/sessions/:id, GET /v1/sessions/:id/events
      probe.ts                            # POST /v1/probe
      health.ts                           # GET /v1/health
    docker/
      client.ts                           # dockerode instance, honours DOCKER_HOST / socketPath
      run-session.ts                      # spawn, attach streams, handle exit, kill
      probe.ts                            # staged checks (daemon reachable, image present)
    session/
      registry.ts                         # Map<sessionId, SessionEntry>; shutdown sweep
      bundle-workdir.ts                   # mkdir under BUNDLE_ROOT/<id>, write files, rm on close
    sse/
      channel.ts                          # SSE writer with heartbeat + Last-Event-ID replay buffer
    types.ts                              # local mirrors of RunStatus / RunEvent / AvailabilityReport
  tests/
    routes.test.ts                        # vitest; docker client mocked
    bundle-workdir.test.ts

apps/telo-editor/src/run/adapters/docker-api/     # new adapter; second citizen next to tauri-docker
  adapter.ts                                       # implements RunAdapter via fetch + EventSource
  config-schema.ts                                 # TelodockerApiConfig + JSONSchema7
  sse-client.ts                                    # thin EventSource wrapper with typed events
```

The `apps/telo-editor/src/run/` boundary from [run-adapters.md](./run-adapters.md) is unchanged — the new adapter is just another directory under `adapters/`, registered through `registry.ts`.

---

## HTTP API contract

All request and response bodies are JSON, `content-type: application/json`, except `/events` which is `text/event-stream`.

### `POST /v1/sessions`

Start a run. Request body:

```ts
{
  bundle: RunBundle;                      // exactly the shape from src/run/types.ts
  env: Record<string, string>;
  config: {
    image: string;                        // e.g. "telorun/telo:nodejs"
    pullPolicy: "missing" | "always" | "never";
  };
}
```

The runner always talks to the local daemon via `/var/run/docker.sock`. There is no remote-daemon support and none is planned — the runner is the deployment unit; if you want to run on another host, run another runner there.

Response (201):

```ts
{
  sessionId: string;                      // UUID v4; runner-generated
  streamUrl: string;                      // "/v1/sessions/<id>/events"
  createdAt: string;                      // ISO 8601
}
```

Failure modes (all are pre-start — see *Session-create atomicity* below for the rule):

- 400 — malformed body, missing required fields. Response: `{ error: "invalid_request", message, issues?: ConfigIssue[] }`.
- 409 — runner at its configured max concurrent sessions (default 8; env `RUNNER_MAX_SESSIONS`). Response: `{ error: "too_many_sessions" }`. The editor treats this as a transient `failed` and surfaces the message verbatim.
- 502 — image acquisition failed. Response: `{ error: "pull_failed", stage: "pull"|"inspect", message, daemonMessage }`.
  - `stage: "pull"` — registry unreachable, image not found on the registry, auth required. Applies to `pullPolicy: "always"` and to `pullPolicy: "missing"` when the image isn't local.
  - `stage: "inspect"` — `pullPolicy: "never"` and the image isn't present locally.
  - `daemonMessage` is the raw Docker Engine error (e.g. `manifest for foo/bar:tag not found`) — the editor surfaces it verbatim so users see the actual cause.
- 503 — Docker daemon unreachable or `createContainer` / `attach` / `start` fails for daemon-level reasons. Response: `{ error: "start_failed", stage: "daemon"|"create"|"attach"|"start", message, daemonMessage? }`. The editor maps to `RunStatus.failed` with the message.

**Rule: any failure before `container.start()` returns non-2xx; nothing appears on SSE.** Any failure after `container.start()` emits on SSE and the HTTP response has already been a 201. This gives the editor a single, non-ambiguous contract — a 201 means "you have a session id and should subscribe to `/events`"; anything else means "this run never began."

### `DELETE /v1/sessions/:id`

Stop a session. Idempotent — 204 whether the session exists or not. The actual status transition (`stopped`) is emitted on the SSE stream, not in this response.

Race against natural exit: the container may already have exited and been `AutoRemove`d when DELETE arrives. `container.kill()` then rejects with a daemon 404. The handler catches that specific error and still returns 204 — the exit task has already shipped (or is about to ship) the terminal status event, so there is nothing left to do. Any other daemon error on kill is propagated as 500.

### `GET /v1/sessions/:id`

Snapshot. Response:

```ts
{
  sessionId: string;
  status: RunStatus;                      // { kind: "running" } etc.
  createdAt: string;
  exitedAt?: string;
}
```

404 if the session is not in the registry (never existed, or was evicted — see *Session lifecycle*).

### `GET /v1/sessions/:id/events`

SSE stream. Content-type `text/event-stream`. Events:

```
id: 1
event: status
data: {"kind":"starting"}

id: 2
event: stdout
data: {"chunk":"hello\n"}

id: 3
event: status
data: {"kind":"exited","code":0}
```

Event types map 1:1 onto `RunEvent`: `stdout`, `stderr`, `status`. The `id:` header is a monotonic counter scoped to the session — used for `Last-Event-ID` replay (see *Streaming semantics*).

Heartbeat: the server writes `: heartbeat\n\n` (SSE comment frame) every 20 seconds. Two benefits — keeps proxies from idle-timing out the connection, and gives `EventSource` a liveness signal.

Connection close: the server closes the stream after emitting a terminal status event (`exited` / `failed` / `stopped`). Clients subscribed after that point get the full replayed history plus an immediate close — see *Session lifecycle* for TTL.

### `POST /v1/probe`

Availability check. Request body:

```ts
{ config: { image: string; pullPolicy: "missing" | "always" | "never" } }
```

Same `config` shape that appears as the `config` field of `POST /v1/sessions` — no bundle, no env. Response is an `AvailabilityReport` verbatim, the same union the adapter already consumes.

### `GET /v1/health`

Lightweight liveness for compose's healthcheck:

```ts
{ ok: true, version: "0.1.0" }
```

Returns 200 whether or not the Docker daemon is reachable — this is a runner-process health check, not a daemon probe. Use `/v1/probe` for that.

---

## Streaming semantics

### Framing

Each chunk emitted by a spawned container becomes exactly one SSE `event` frame. No coalescing, no line buffering on the server side — the client ([src/run/adapters/docker-api/sse-client.ts](apps/telo-editor/src/run/adapters/docker-api/sse-client.ts)) does the same partial-line buffering `LogStream` already does for the Tauri adapter. Order across `stdout` / `stderr` / `status` is preserved by the server's single-threaded emit loop per session.

### Last-Event-ID replay

The server keeps a per-session ring buffer capped by **total payload bytes**, not event count. Default `RUNNER_REPLAY_BUFFER_BYTES=5_000_000` (5 MB). Event-count caps are a bad fit here: a chatty run emits thousands of tiny stdout frames per second and a 10 000-event cap would cover only a few seconds, while a quiet run could keep megabytes' worth of output resident under the same cap. Bytes are the resource the buffer actually consumes.

Implementation: each buffered entry tracks its `JSON.stringify(payload).length`; when a new event would push total size past the cap, oldest entries are evicted FIFO until it fits. Entries are never split — we evict whole events.

Resume comes from two independent signals:

1. **Native auto-reconnect of a live `EventSource`.** The browser sends `Last-Event-ID: <n>` as a request header on the retry. This covers transient network blips within the same page session.
2. **Tab reload / editor restart.** A fresh `EventSource` instance does *not* carry the previous id — the browser only tracks it for the lifetime of one object, and `EventSource` cannot set custom headers. The server therefore also accepts a `?lastEventId=<n>` query param on `GET /v1/sessions/:id/events`, and `sse-client.ts` persists `lastEventId` to `sessionStorage` keyed by `sessionId` after every event. On construction it reads the stored id and appends `?lastEventId=<n>` to the URL.

The server prefers the header when both are present (native auto-reconnect is the trustworthy path); otherwise it takes the query param. Replay semantics are identical for both paths: the server replays `(n, max]`. If the requested id has been evicted, the server responds with `event: gap\ndata: {"reason":"buffer_evicted"}` and then streams from the current tail. The client surfaces a single banner line in `LogStream`: `(stream reconnected — earlier output truncated)`.

Stdout frame coalescing: the server does not coalesce. dockerode's demuxed stream already hands us reasonably sized chunks (~4–64 KB typical), and coalescing at the server would delay output for interactive latency with no benefit beyond buffer density. Revisit only if a real workload blows past 5 MB/session in a way the user cares about.

Replay is strictly on reconnect, not for late subscribers who never subscribed initially. If a session is created and nobody connects to `/events` for 30 s, the server still collects output into the ring buffer. This lets a tab reload reliably recover the run, which is the v1 use case for replay; we are not trying to support "kick off a run, close the browser, come back tomorrow."

### Why SSE, not WebSocket

Called out in the discussion — recording the reasoning here for future readers. SSE is half-duplex (server → client), which fits the problem exactly. It needs no framing protocol on top of HTTP/1.1, no handshake, no `sec-websocket-*` plumbing, no proxy quirks beyond the heartbeat. `EventSource` auto-reconnects with `Last-Event-ID` for free. If stdin forwarding or client-side backpressure lands later, that is an *additive* change: a sibling `POST /v1/sessions/:id/input` endpoint, not a WebSocket rewrite.

---

## Session lifecycle

```
POST /v1/sessions
   │
   ├─ mkdir BUNDLE_ROOT/<id>, write files, chmod 0755     bundle-workdir.ts
   ├─ ensureImage(image, pullPolicy)                      docker/run-session.ts
   │    ├─ always   → docker.pull(image)
   │    ├─ missing  → docker.getImage(image).inspect()
   │    │              └─ 404 → docker.pull(image)
   │    └─ never    → docker.getImage(image).inspect()
   │                   └─ 404 → fail (pull_failed, stage: "inspect")
   ├─ docker.createContainer({
   │     Image: config.image,
   │     name: "telo-run-<id>",
   │     Cmd: [entryRelativePath],
   │     WorkingDir: "/srv/<id>",
   │     HostConfig: {
   │       Binds: [`${BUNDLE_VOLUME}:/srv`],              shared named volume
   │       AutoRemove: true,
   │       NetworkMode: RUNNER_CHILD_NETWORK              required env; see below
   │     },
   │     Env: [FORCE_COLOR=1, CLICOLOR_FORCE=1, ...request.env]     exactly these; no process.env passthrough
   │  })
   ├─ container.attach({stream, stdout, stderr, logs})    dockerode demux → split(stdout, stderr)
   ├─ container.start()
   ├─ register session in registry
   ├─ emit status=starting → running
   └─ 201 { sessionId, streamUrl }
```

### `ensureImage` — pullPolicy semantics

Unlike `docker run` on the CLI, `docker.createContainer` on the Engine API does **not** auto-pull missing images — it fails with `No such image`. The runner's `ensureImage` step fills that gap explicitly:

- `always` — pull unconditionally. Guarantees the latest remote digest.
- `missing` — inspect locally; pull only if the image isn't present. Fast in the common case (image already there), honest about the first run.
- `never` — inspect only; if the image isn't present, fail with `pull_failed` / stage `"inspect"` before any container is created. No network access ever.

Pull progress: dockerode's `docker.pull()` returns a stream of `{ status, id, progressDetail }` events. v1 drains and discards the stream (`docker.modem.followProgress` with a no-op onProgress) and just waits for completion. The 201 response is held until pull completes, which matches `tauri-docker`'s semantics and keeps `RunStatus` unchanged. Consequence: `POST /v1/sessions` can hang 10–60 s on cold-image runs. The editor's fetch carries a 90 s timeout; cold-pull UX ("pulling image…") is a future `RunStatus.pulling` variant once both adapters want it, scoped out of this plan.

### Session-create atomicity

The sequence above is **all-or-nothing up to `container.start()`**. Any failure in mkdir / pull / create / attach / start:

1. The bundle workdir is removed.
2. If a container was created (but not yet started), it is removed.
3. Nothing is inserted into the session registry.
4. The HTTP response is a non-2xx with a structured error. Status mapping: image-acquisition failures → 502 `{ error: "pull_failed", stage: "pull"|"inspect", ... }`; daemon/create/attach/start failures → 503 `{ error: "start_failed", stage: "daemon"|"create"|"attach"|"start", ... }`. Matches the failure-mode table above.

Only after `container.start()` succeeds and the attach streams are wired does the session appear in the registry and the 201 return. This eliminates the "is the session registered?" ambiguity: if you got a 201 you have a `sessionId`; if you didn't, you don't, and the runner is back to a clean state.

Failures *after* `container.start()` (attach read error, container exits immediately with non-zero code, OOM kill) are in-session failures: they emit `status=failed`/`exited` on the SSE stream and go through the normal exit path. The 201 has already shipped; the client discovers these via `/events`.

### Exit, cleanup, and TTL

```
container exits → emit status=exited/failed
   │
   ├─ remove bundle workdir
   └─ schedule eviction from registry (TTL 5 min, tunable via RUNNER_EXIT_TTL)
```

The 5-minute TTL after exit lets the editor reconnect and see the final output if the user bounces the tab. After eviction, `GET /v1/sessions/:id` returns 404 and the SSE stream returns 410 Gone.

`DELETE /v1/sessions/:id` calls `container.kill()` and marks `userStopped=true` on the entry; the attach stream's close handler sees the flag and emits `status=stopped` rather than `status=exited` (matches the Rust adapter's semantics). Because `AutoRemove: true` is set, the container is gone by the time the exit task runs — no cleanup call needed.

### Env isolation

The `Env` field on `createContainer` is constructed **exactly** from `[FORCE_COLOR=1, CLICOLOR_FORCE=1, ...Object.entries(request.env)]`. There is no `process.env` passthrough, no merging with runner-container env, no defaults from the image's `ENV` directives overridden by accident (the image's own `ENV` still applies — that's fine, that's the image contract). The runner's internal env (`PORT`, `BUNDLE_ROOT`, `BUNDLE_VOLUME`, anything else) must not leak into CEL's `env.*` namespace for the spawned process. Enforced by a single-source construction in `docker/run-session.ts` and a unit test that asserts unrelated runner env vars do not appear in the `Env` array.

### Child network

`RUNNER_CHILD_NETWORK` is **required**, not defaulted to `"bridge"`. Rationale: the compose case (the driving v1 motivation) has the editor running manifests that reference sibling services by name (`db`, `storage`, `registry`). A container started on the host's default `bridge` network cannot resolve those hostnames — the manifest silently fails. Making the env var required forces the operator to make a conscious choice and surfaces the contract in error messages when it's wrong.

- In compose: `RUNNER_CHILD_NETWORK: telo_default` (compose auto-creates this network from the pinned project name `telo`). Manifests can reach sibling services by service name.
- Standalone: `-e RUNNER_CHILD_NETWORK=bridge` to keep today's simple case working, or the operator's own user-defined bridge name.
- At boot the runner calls `docker.getNetwork(RUNNER_CHILD_NETWORK).inspect()` and fails fast if the network doesn't exist. `/v1/probe` surfaces the same check to the editor.

### Runner shutdown

On `SIGTERM`/`SIGINT`, the runner kills every live container via `docker.getContainer(name).kill()`, awaits all exits, then exits. This is the server-side mirror of the Tauri adapter's window-close hook. Compose's default `stop_grace_period` (10 s) is enough; if it isn't, containers get SIGKILL via the daemon and `AutoRemove` still cleans the filesystem.

---

## Bundle filesystem handoff

**The problem.** The runner lives in a container. When it calls `docker run -v <path>:/srv`, `<path>` is resolved **on the host daemon**, not inside the runner. A path like `/tmp/telo-abc` that the runner `mkdir`'d inside its own filesystem does not exist on the host and the bind mount silently mounts an empty directory.

**The fix.** A named volume `telo-runner-bundles`, mounted at `/bundles` inside the runner and at `/srv` inside every spawned container. The runner writes bundle files to `/bundles/<sessionId>/...`; the spawned container reads them at `/srv/<sessionId>/...` with `WorkingDir: /srv/<sessionId>`. Same bytes, two paths, zero translation.

- In the runner: `BUNDLE_ROOT=/bundles` (env var, default `/bundles`).
- In the spawned container: always `/srv`. The runner passes `BUNDLE_VOLUME=telo-runner-bundles` as an env var and uses it for the `Binds` spec.
- Standalone deployments must pass the volume **and** tell the runner its daemon-visible name via `BUNDLE_VOLUME`, because the runner has no way to learn that name from inside the container:
  ```
  docker run --rm \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v telo-runner-bundles:/bundles \
    -e BUNDLE_VOLUME=telo-runner-bundles \
    -e RUNNER_CHILD_NETWORK=bridge \
    -p 127.0.0.1:8061:8061 \
    telorun/docker-runner
  ```
  `RUNNER_CHILD_NETWORK` is required — `bridge` is the right value for a lone runner with no sibling services to reach. Operators running the runner alongside a user-defined bridge network set it to that name instead.
  `BUNDLE_VOLUME` is **required**, not best-effort. At boot the runner:
  1. Refuses to start if `BUNDLE_VOLUME` is unset — exit non-zero with `"BUNDLE_VOLUME env var is required; see docker-runner README"`. This kills silent misconfiguration where an anonymous `-v /bundles` looks identical to a properly-named `-v telo-runner-bundles:/bundles` via `/proc/mounts` but makes cross-container handoff impossible.
  2. Calls `docker.getVolume(BUNDLE_VOLUME).inspect()` against the target daemon. Missing volume → runner exits with a remediation message pointing at `docker volume create <BUNDLE_VOLUME>`. Daemon unreachable at boot is logged but not fatal, since `/v1/probe` is the right place to surface that once the editor connects; `/v1/probe` re-runs the volume inspect and returns `unavailable` if still broken.

Alternative considered and rejected: Docker 25+ subpath volume mounts (`--mount type=volume,source=...,target=/srv,volume-subpath=<sessionId>`). Cleaner isolation (container sees only its own bundle) but introduces a hard Docker version floor for a weak benefit (bundles are not secret; co-located siblings is fine on a trusted runner). Revisit if we ever gate bundles behind auth.

Cleanup: on session exit and on runner startup, purge `/bundles/<id>` directories that have no matching live container on the daemon. The startup sweep covers ungraceful restarts.

### UID alignment between runner and spawned containers

The runner's `node:24-slim` base runs as root by default, and the current [cli/nodejs/Dockerfile](../../../../cli/nodejs/Dockerfile) for `telorun/telo` has no `USER` directive — so both sides are root and a bundle written 0600 by the runner is readable by the spawned container today. This is coincidental, not load-bearing, and will break the day `telorun/telo` adds `USER node` for hardening. Two countermeasures, both cheap, both applied together:

1. **chmod 0755 / chown -R on the bundle workdir after write**, before `container.start()`. The runner owns the directory; this ensures any non-root reader can traverse and read. Files are not secret — the bundle is just manifest text the editor already has.
2. **Runner fails fast on boot if its own UID differs from what it expects.** On any future migration to a non-root runner, the Dockerfile pins `USER` and the runner asserts `process.getuid() === <expected>` at startup so mismatches surface as a crash with a clear message, not as "my container can't read its own files."

If `telorun/telo` later standardizes on a specific non-root UID (e.g. `1000`), point 1 becomes `chown -R 1000:1000` against that known value. Out of scope to pre-build that machinery now; the post-write chmod covers today's root-both-sides and tomorrow's non-root-reader cases.

---

## Availability & config

### `TeloDockerApiConfig` (editor-side)

```ts
interface TeloDockerApiConfig {
  baseUrl: string;                        // e.g. "http://runner:8061" or "http://localhost:8061"
  image: string;                          // forwarded in POST /v1/sessions
  pullPolicy: "missing" | "always" | "never";
}
```

No `authToken` field in v1 — matches the "no auth" decision. The field is deliberately not stubbed in to keep the schema honest; adding it later is additive.

### `validateConfig`

- `baseUrl` required, must parse as a URL with `http:` or `https:` scheme.
- `image` required, non-empty.
- `pullPolicy` required, enum.

### `isAvailable`

1. `GET <baseUrl>/v1/health` with 2 s timeout.
   - Network error / wrong host → `{ status: "unavailable", message: "Runner unreachable at <baseUrl>.", remediation: "Start the docker-runner service or fix the URL." }`.
   - Non-2xx → `{ status: "unavailable", message: "Runner returned HTTP <status> on /v1/health." }`.
2. `POST <baseUrl>/v1/probe` with the full config. Response IS an `AvailabilityReport`, returned verbatim — the runner owns the daemon-probe staged checks and we don't duplicate them client-side.

This keeps the adapter dumb: it is a transport. The daemon-present / image-pullable logic lives in one place (inside the runner, where it can actually observe the daemon).

---

## Editor adapter implementation

`src/run/adapters/docker-api/adapter.ts`:

```ts
export const teloDockerApiAdapter: RunAdapter<TeloDockerApiConfig> = {
  id: "docker-api",
  displayName: "Docker runner (HTTP)",
  description: "Runs the Application via a docker-runner HTTP service.",
  configSchema: teloDockerApiConfigSchema,
  defaultConfig: teloDockerApiDefaultConfig,

  validateConfig(config) { /* see above */ },

  async isAvailable(config) {
    const health = await fetchWithTimeout(`${config.baseUrl}/v1/health`, { timeout: 2000 });
    if (!health.ok) return { status: "unavailable", message: ... };
    const probe = await fetch(`${config.baseUrl}/v1/probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config }),
    });
    return (await probe.json()) as AvailabilityReport;
  },

  async start(request, config) {
    const res = await fetch(`${config.baseUrl}/v1/sessions`, { method: "POST", ... });
    if (!res.ok) throw new Error(await res.text());
    const { sessionId, streamUrl } = await res.json();

    const sse = openSseClient(`${config.baseUrl}${streamUrl}`);
    // sse-client.ts fans out to subscribers, tracks Last-Event-ID automatically via EventSource.

    let currentStatus: RunStatus = { kind: "starting" };
    const subscribers = new Set<(e: RunEvent) => void>();
    sse.on("status", (s) => { currentStatus = s; emit({ type: "status", status: s }); });
    sse.on("stdout", (chunk) => emit({ type: "stdout", chunk }));
    sse.on("stderr", (chunk) => emit({ type: "stderr", chunk }));

    return {
      id: sessionId,
      getStatus: () => currentStatus,
      subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); },
      async stop() {
        await fetch(`${config.baseUrl}/v1/sessions/${sessionId}`, { method: "DELETE" });
      },
    };
  },
};
```

Shape matches `tauri-docker` 1:1. No editor wiring changes beyond registering the adapter in `src/run/registry.ts`. Settings picks up the new option automatically via `registry.list()`.

### `sse-client.ts`

Thin wrapper over `EventSource` that:
- Parses each frame's `data` as JSON.
- Dispatches to typed listeners (`on("stdout", handler)`, etc.).
- Closes itself on receipt of a terminal status event.
- Exposes a `close()` for explicit teardown on `stop()` or Run view dismiss.

No retry logic here beyond what `EventSource` does natively — the browser auto-reconnects with `Last-Event-ID` for free. If the server returns 410 (session evicted), the wrapper closes silently and emits a synthetic `{ type: "status", status: { kind: "failed", message: "Session expired" } }`.

### Boundary check

Per the lint rule from [run-adapters.md](./run-adapters.md), nothing outside `src/run/` imports the adapter directly; registration happens inside `src/run/registry.ts`. This adapter adds zero new import surface for the rest of the editor.

---

## Runner implementation notes

### Runtime & deps

Node.js 24 (matches the compose `editor` service and the CLI). TypeScript, ES modules, compiled with the existing `tsc` pipeline used across the monorepo.

Runtime dependencies:
- `fastify` — HTTP server. Picked over Express because its SSE support (via `fastify-sse-v2` or a tiny inline handler) is cleaner; over plain `http` because we get route parsing, validation, and schema-driven request parsing for free.
- `dockerode` — Docker Engine API client. Supports both `/var/run/docker.sock` and `tcp://` endpoints, streams demuxing, pull events, container lifecycle.
- `pino` — structured logs.
- `zod` (optional) — request body validation. Fastify's JSON Schema validation is sufficient for the shapes we have; zod is only worth adding if the contract gets more complex. Start without.

Dev dependencies:
- `vitest`, `@types/node`, `typescript`, `tsx` for development runs.

No production build step beyond `tsc --outDir dist`. The Docker image runs `node dist/server.js`.

### Docker Engine API specifics

- Use `docker.modem.followProgress` for `docker.pull` so we can stream progress into log events (optional; default `pullPolicy: "missing"` makes this rare).
- Attach mode: `{ stream: true, stdout: true, stderr: true, logs: true }`. The `logs: true` is load-bearing — it replays the container's stdout from container start even if our attach call lost a race. Without it, output emitted between `createContainer` + `start` + `attach` is dropped.
- Stream demux: dockerode handles Docker's multiplexed header frames for us via `docker.modem.demuxStream(stream, stdout, stderr)` where `stdout`/`stderr` are `PassThrough` instances.
- UTF-8 continuation handling: same concern as the Rust adapter — multi-byte sequences can straddle chunk boundaries. Port the `split-at-incomplete-utf8` helper. Node has no built-in equivalent for streams.

### Probe staging

Mirrors the Tauri adapter's staged checks, running against `dockerode`. First failing stage wins, so the editor surfaces one concrete reason at a time.

1. **Daemon.** `docker.ping()` → unavailable if the daemon is not reachable at `/var/run/docker.sock`. Remediation: "Ensure /var/run/docker.sock is bind-mounted into the runner container."
2. **Bundle volume.** `docker.getVolume(BUNDLE_VOLUME).inspect()` → unavailable if the configured volume doesn't exist on the daemon. Remediation: "Run `docker volume create <BUNDLE_VOLUME>` or start the runner with the volume mounted."
3. **Child network.** `docker.getNetwork(RUNNER_CHILD_NETWORK).inspect()` → unavailable if the configured network doesn't exist. Remediation: "Set `RUNNER_CHILD_NETWORK` to an existing docker network, or create it." This stage exists so "manifest can't reach sibling services" surfaces before the first run rather than as a silent DNS failure inside the spawned container.
4. **Image.** `pullPolicy !== "always"` → `docker.getImage(config.image).inspect()`. Not found + `"never"` → unavailable. Not found + `"missing"` → `ready` (noted pull-pending; surfaced in UI as a hint, same as Tauri adapter).
5. Everything OK → `ready`.

Stages 2 and 3 are runner-environment concerns, not per-request config; their failure modes point at operator action on the runner deployment, not at the editor's adapter form.

### Session registry

Single in-process `Map<sessionId, SessionEntry>`. Each entry holds: container id, name, bundle workdir path, `userStopped: boolean`, ring buffer, exit-event emitter, eviction timer. `pino` logs every state transition with the session id as a field so operators can grep one run.

---

## Dockerfile

Mirrors the `registry` pattern.

```dockerfile
FROM node:24 AS development
WORKDIR /app
RUN corepack enable
CMD ["pnpm", "run", "--filter", "@telorun/docker-runner", "dev"]

FROM development AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm run --filter @telorun/docker-runner build
# pnpm deploy produces a self-contained, hoisted node_modules for a single
# workspace package at /out, rewriting workspace:* deps and pruning devDeps.
# This is the pnpm-blessed way to ship one package from a monorepo and
# sidesteps the isolated-node-linker / symlinked-store issue entirely.
RUN pnpm deploy --filter=@telorun/docker-runner --prod /out

FROM node:24-slim AS production
WORKDIR /app
COPY --from=build /out ./
ENV PORT=8061 BUNDLE_ROOT=/bundles
# Deliberately NO `VOLUME ["/bundles"]`:
# A VOLUME directive makes Docker auto-create an anonymous volume at /bundles
# if the operator runs the image without -v <named>:/bundles. That anonymous
# volume is invisible to spawned sibling containers, which then see an empty
# /srv — exactly the silent-failure mode this plan avoids by requiring a
# named volume. The runner's boot-time BUNDLE_VOLUME check is the sole
# enforcement point.
# Deliberately NO default BUNDLE_VOLUME in ENV:
# There is no safe default. Every deployment mode (compose / standalone) must
# make a deliberate choice and pass it in. The runner refuses to start when
# unset, which is the intended behavior.
EXPOSE 8061
CMD ["node", "dist/server.js"]
```

Image is `telorun/docker-runner:${tag}`. Published through the same CI that publishes `telorun/registry` — leave that to the existing release workflow.

---

## docker-compose integration

The compose project name is pinned to `telo` at the top of [docker-compose.yml](../../../../docker-compose.yml), which makes the daemon-visible volume names stable (`telo_<key>`) and lets the hand-coded `BUNDLE_VOLUME` value below be trusted.

One contract to call out before the snippet: the runner seed env var on the `editor` service MUST be `VITE_*`-prefixed. Vite only exposes `VITE_*` env vars to client code; a bare `TELO_RUNNER_URL` is invisible to `import.meta.env`.

Added as a sibling service:

```yaml
runner:
  image: telorun/docker-runner:${DOCKER_TAG:-latest}
  build:
    context: .
    dockerfile: ./apps/docker-runner/Dockerfile
    target: ${DOCKER_TARGET:-development}
  volumes:
    - .:/app                              # dev mode: source bind-mount for hot reload
    - /var/run/docker.sock:/var/run/docker.sock
    - runner-bundles:/bundles
  working_dir: /app
  environment:
    PORT: 8061
    BUNDLE_ROOT: /bundles
    BUNDLE_VOLUME: telo_runner-bundles     # compose prefixes volume keys with the project name (telo)
    RUNNER_CHILD_NETWORK: telo_default     # compose auto-creates this; required so spawned containers can reach sibling services
  ports:
    - "127.0.0.1:8061:8061"              # loopback only — see `Security posture` below
  healthcheck:
    test: ["CMD", "wget", "-q", "-O-", "http://localhost:8061/v1/health"]
    interval: 10s
    timeout: 2s
    retries: 3

editor:
  # …existing…
  environment:
    VITE_TELO_RUNNER_URL: http://runner:8061    # VITE_ prefix required — Vite only exposes VITE_* to client code
  depends_on:
    runner:
      condition: service_healthy

volumes:
  # …existing…
  runner-bundles:
```

Volume-name subtlety: compose prefixes volumes with the project name, so with `name: telo` the daemon-visible name of `runner-bundles` becomes `telo_runner-bundles`. The runner uses `BUNDLE_VOLUME` (the daemon-visible name) in the `Binds` spec for spawned containers — not the compose-local key. In standalone deployments the user picks the volume name and matches it in `BUNDLE_VOLUME`; there is no compose prefix to reason about.

The editor reads `import.meta.env.VITE_TELO_RUNNER_URL` as the seed value for the `docker-api` adapter's `baseUrl` when populating `defaultConfig`. If unset, the default is `http://localhost:8061` — which works for standalone `docker run` with `-p 127.0.0.1:8061:8061`.

---

## Security posture

The runner has an unauthenticated HTTP API and holds a bind mount to `/var/run/docker.sock`. Any HTTP client that can reach `/v1/sessions` can instruct the runner to start a container with arbitrary image, arbitrary command, arbitrary bind mounts — i.e. root-equivalent on the host daemon. This plan intentionally has no auth (per the "no auth" decision), which means **port exposure is the entire security boundary**.

Hard rules:

1. **Default bind is `127.0.0.1`.** The compose `ports:` entry is `127.0.0.1:8061:8061`, and the standalone `docker run` example uses `-p 127.0.0.1:8061:8061`. Binding `0.0.0.0` is reserved for LAN-only, operator-owned setups where the operator has independently decided the network is trusted. The runner does not facilitate this — operators have to type it themselves.
2. **No auth is not the same as no boundary.** The runner only accepts requests on loopback by default; the editor connects via loopback (Tauri host) or via the compose bridge network (`http://runner:8061`, reachable only from co-resident containers).
3. **The runner container image includes no credentials and no Docker CLI.** Only dockerode + the Engine socket. An attacker gaining RCE in the runner has docker daemon access but no further secrets.
4. **Session container names are `telo-run-<uuid>`.** Predictable only post-creation; does not expose anything about other sessions.

This posture is documented here rather than as a follow-up because the port default is the material mitigation — flipping it after the fact is a regression risk.

---

## PR breakdown

Each PR leaves the repo working.

### PR 1 — `apps/docker-runner` skeleton + HTTP surface

- **Prerequisite edit:** extend [pnpm-workspace.yaml](../../../../pnpm-workspace.yaml) to include the new package. The workspace currently lists `apps/telo-editor` explicitly (not `apps/*`), so a new app under `apps/` is invisible to pnpm until declared. Replace the `apps/telo-editor` line with `apps/*`, or add `apps/docker-runner` as a second entry — prefer the glob, since the repo will keep accumulating apps.
- `package.json` (name `@telorun/docker-runner`, matching the repo's scope convention) with at minimum a `build` script (`tsc`) and a `dev` script (`tsx watch src/server.ts` or equivalent). The Dockerfile's `development` and `build` stages invoke these; missing scripts = image build fails silently at those steps.
- `tsconfig.json`, `src/server.ts`, `src/routes/health.ts`.
- `GET /v1/health` only.
- Vitest with one smoke test asserting `/v1/health` returns `{ ok: true }`.
- Dockerfile (development target) builds and runs.
- No docker-runner logic yet. Image is a do-nothing healthcheck.

### PR 2 — Probe + dockerode client

- `src/docker/client.ts`, `src/docker/probe.ts`, `src/routes/probe.ts`.
- `POST /v1/probe` returns `AvailabilityReport`.
- Unit tests with `dockerode` mocked for the three probe outcomes.
- Hand-tested against a real daemon via `pnpm run --filter @telorun/docker-runner dev` + `curl`.

### PR 3 — Session lifecycle + SSE streaming

- `src/docker/run-session.ts`, `src/session/registry.ts`, `src/session/bundle-workdir.ts`, `src/sse/channel.ts`, `src/routes/sessions.ts`.
- `POST /v1/sessions`, `GET /v1/sessions/:id`, `DELETE /v1/sessions/:id`, `GET /v1/sessions/:id/events`.
- Ring-buffer replay with `Last-Event-ID`.
- Runner shutdown hook that kills live containers on SIGTERM.
- Hand-tested end-to-end against `telorun/telo:nodejs` with a one-resource hello manifest.

### PR 4 — docker-compose wiring + production Dockerfile target

- `runner` service added to `docker-compose.yml`.
- `editor` service gets `VITE_TELO_RUNNER_URL` env (the `VITE_` prefix is required — Vite only exposes `VITE_*` to client code) + `depends_on: { runner: { condition: service_healthy } }`.
- Production Dockerfile stage.
- Named volume `runner-bundles` wired.
- Manual QA: `docker compose up -d runner` + `curl -X POST http://localhost:8061/v1/probe …`.

### PR 5 — Editor adapter

- `apps/telo-editor/src/run/adapters/docker-api/` (adapter, config schema, sse client).
- `registry.register(teloDockerApiAdapter)` in `src/run/registry.ts`.
- `defaultConfig.baseUrl` seeds from `import.meta.env.VITE_TELO_RUNNER_URL ?? "http://localhost:8061"`.
- Settings picker automatically lists it — no `SettingsModal` changes.
- Run end-to-end inside the compose editor against the runner.

### PR 6 — Tests

- Integration test that stands up the runner (via `dockerode` against the test host's daemon, not nested compose) and exercises the full editor adapter against it. Lives at `apps/telo-editor/src/run/__tests__/docker-api.integration.test.ts` and is gated behind a `RUN_INTEGRATION=1` env so CI boxes without a daemon don't block.
- Fixture: a one-file manifest bundle that runs `echo hello && exit 0`.
- Documentation in `apps/docker-runner/README.md` covering standalone run, compose run, and env vars.

---

## Error handling & edge cases

- **Bundle write fails mid-write** (disk full on the named volume). Clean up the partial directory, return 503 from `POST /v1/sessions`.
- **Image pull in progress when session stops.** `docker.pull` returns a stream; the runner cancels it by ending the stream. Session transitions straight to `stopped`.
- **Container exits before attach completes.** `logs: true` in the attach options replays the full output, so we still see it. The exit handler races the attach handler — both must be idempotent under the session registry's single mutex.
- **Client disconnects mid-stream.** The run continues. Ring buffer accumulates. Next `/events` request with `Last-Event-ID` resumes.
- **Runner restarts mid-run.** Every live container is killed during shutdown. On next boot, the startup sweep finds no matching sessions in the (now-empty) registry and deletes the orphan `/bundles/<id>` directories. Editors holding a session reference see connection errors on `/events` — they translate to `failed` with message "Runner restarted."
- **Two editors hitting the same runner.** Not an issue — session ids are UUIDs, unique per request, and the editor doesn't enumerate other editors' sessions.

---

## Risks & open items

1. **Ring-buffer memory bound.** 5 MB per session × 8 concurrent sessions = 40 MB worst case in steady state. `RUNNER_REPLAY_BUFFER_BYTES` tunes per session; `RUNNER_MAX_SESSIONS` tunes concurrency. Flag for revisit if operators start running many sessions on a constrained runner.
2. **Windows developer experience.** Docker Desktop on Windows exposes the socket differently. The runner lives inside a Linux container regardless of host, so compose users are fine. Developers running the runner *natively* on Windows (without Docker) aren't supported — use the compose path.

---

## Future hooks (deliberately not built)

- **Auth.** Add `authToken?: string` to the config; runner reads `RUNNER_TOKEN` env; `Authorization: Bearer` on every request; 401 maps to `{ status: "needs-setup", issues: [{ path: "/authToken", … }] }`. Trivial extension.
- **TLS.** Put the runner behind the existing `proxy` (Caddy) service; add `https` to the `baseUrl` scheme list in `validateConfig`. No runner changes.
- **Kernel-event stream.** When [run-adapters.md](./run-adapters.md) introduces `{ type: "kernel"; event: KernelEvent }`, the runner gains a fourth SSE event type and the `docker-api` adapter passes it through — no shape change to the HTTP API.
- **Multi-session UX in the editor.** `RunContext` becomes a map; nothing about this adapter changes. The runner already supports it.
- **Log replay across runner restarts.** Persist the ring buffer to disk (under `/bundles/<id>/.log`). Out of scope; none of the v1 use cases need it.
