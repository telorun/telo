# @telorun/runner-core

Backend-neutral core shared by the Telo runners: [`docker-runner`](../../apps/docker-runner),
[`k8s-runner`](../../apps/k8s-runner) and `telo runner`, the local-process
runner the CLI serves. It owns everything about a session *except* how its
workload is actually created and how a process is spawned in it:

- the `/v1` HTTP+SSE **session contract** and Fastify routes (below);
- **ownership**: resume secrets, DPoP-bound identities, the one credential
  check every session route goes through, and the byte channel's tickets;
- the **session lifecycle** over the durable **session store** — create,
  suspend, resume, delete, idle and running-limit suspends, retention, and
  adoption at boot — with the live **registry**, event/byte **ring buffers**
  (SSE + PTY replay with gap detection) and path traversal guards;
- **runs**: the argv, the env, one debug relay per process, reachability while
  an app runs, and the **run projection** — per-app run outcomes derived from
  the kernel lifecycle events on the debug stream, so the runner never parses a
  terminal to learn how a run ended;
- the **workspace application** (`workspace-app/telo.yaml`), the manifest a
  session's `workspace` container runs. It lives here because the workspace
  surface is part of the `/v1` contract: both container backends mount the same
  bytes;
- base config parsing.

## The seam: `RunnerBackend`

A session is a workspace. The backend creates its **workload** — one idle slot
per application (a container on the container backends) beside the workspace
and an optional agent — and starts nothing in it; a Run is a process start in a
slot that already exists. Core owns what a run means, the backend only spawns,
signals and reports:

- `RunnerBackend`: `probe`, `create(spec, callbacks)`, `adopt?(spec, callbacks)`
  (a workload a previous runner process left; `undefined` when it is gone),
  `destroy(sessionId)` (the workload if any, and the session's storage),
  `supplyTelo?`, `reservedPorts?(apps)` (the ports the workload binds beside
  the apps — a supervisor's, an inspect endpoint's — each `{ app, port,
  protocol, purpose }`), `reapOrphans?({ known, live })` and `containers?`.
- `WorkloadSpec` is `{ sessionId, apps, agent?, config, tokens }` and carries no
  env: **session env reaches an app only through `runApp`**, never a workload's
  definition.
- `BackendWorkload`: `workspace`, `addresses(app)` (the `--inspect` listen
  address core passes, the debug stream URL core relays from, the host core
  dials for reachability), `runApp(app, { runId, argv, env, cwd, io, cols?, rows? })`,
  `stopApp(app, runId, graceMs)`, `writeStdin` / `resize` keyed to the live run,
  `reload`, `applyDeclaredPorts?`, `setApps`, `setAgent`, `suspend` (delete the
  workload, keep the storage) and `detach` (the runner is exiting).
- `WorkloadCallbacks`: `onStatus` (`running` / `failed` only), `onProgress`,
  `onAppState` (the `app` events), `onOutput`, `onRoute`, `onEndpoints`.

Core builds every run's argv, `telo run --watch --no-input --inspect <listen>
--no-open <entry>`, arms one debug relay per process when the app reports
`running` and ends it on the next `ready`, so a new kernel's `Kernel.Starting`
is never skipped as already seen. Reachability is reported only while an app
runs. `buildServer({ backend, config, version, store })` wires a backend into
the full `/v1` app; pass `logStream` when the host's stdout is not the runner's
to write, as it is not inside a CLI.

## The session supervisor

Every app container a container backend creates runs the **session supervisor**
as its main process: a static Linux executable from this package's own crate
(`supervisor/`, not shipped on npm), which runs one process at a time as a
runner asks over one WebSocket and keeps its output in a ring, so a dropped
connection stops nothing. The protocol is normative in
[`specs/supervisor-protocol.md`](specs/supervisor-protocol.md) (generation 1),
pinned by the vectors in `supervisor/vectors/` that the crate and this
package's tests both run. A container backend drives it through
`SupervisorClient`: `connect()`, `run(run)`, `stop(runId, graceMs)`,
`writeStdin(runId, bytes)`, `resize(runId, cols, rows)` and `close()`, with
started / exited / failed / refused and seq-numbered output reported to its
`SupervisorListener`, reconnection replayed from the last seq it holds, and a
generation mismatch, a refused token, a superseded connection and a restarted
supervisor each reported as a distinct termination. Building it, statically
for `x86_64` / `aarch64` musl included, is in
[`supervisor/README.md`](supervisor/README.md).

## Sessions and their routes

| Route | What it does |
| --- | --- |
| `POST /v1/sessions` | `{ workspace, agent?, apps, config? }` → `201 { sessionId, streamUrl, createdAt, resumeSecret? }`. A new session holds no files: the client seeds it through `/workspace`. |
| `GET /v1/sessions` | Identity callers only. `?workspace=` optional → `200 { sessions: [{ sessionId, workspace, status, lastActiveAt }] }`, the caller's own, newest activity first. |
| `GET /v1/sessions/:id` | The record, its status, and each app's `state`, live `runId` and generation. |
| `DELETE /v1/sessions/:id` | Deletes the workload, the storage and the record. `204`. |
| `PUT /v1/sessions/:id/apps` | `{ apps }`, each `{ name, entryRelativePath, ports?, telo? }`. `202`. |
| `PUT /v1/sessions/:id/agent` | `{ name }` (one of `features.agents`) or `{ name: null }`. `202 { agent }`. |
| `POST /v1/sessions/:id/apps/:app/run` | `{ env, io, cols?, rows? }` → `202 { runId }`. |
| `POST /v1/sessions/:id/apps/:app/stop` | Ends the live run → `202 { runId }`, `{ runId: null }` when none is live. |
| `POST /v1/sessions/:id/reload` | `?app=` or every app → `202 { reloaded }`. |
| `POST /v1/sessions/:id/suspend` / `resume` | `202 { sessionId }`. |
| `POST /v1/sessions/:id/owner` | Adoption: an identity caller presents a resume-secret session's secret as `{ resumeSecret }` → `200 { sessionId }`; the owner becomes the identity and the secret stops working. |
| `POST /v1/sessions/:id/io-tickets` | `{ app }` → `201 { ticket, expiresAt }`. |
| `GET /v1/sessions/:id/events`, `/io`, `/workspace`, `/workspace/file`; `POST /workspace` | The event stream, the byte channel, the workspace surface. |

Refusals, each `{ error, message }`: `400` `invalid_app_name`,
`reserved_app_name`, `duplicate_app_name`, `invalid_entry`, `port_conflict`,
`invalid_telo_version`, `telo_version_unsupported`, `telo_version_unavailable`
(with `app`, `version`, `reason`), `invalid_config`, `unknown_agent`,
`agent_port_conflict`, `io_unsupported`,
`invalid_path`, `resume_secret_on_create`; `401 session_auth_required`,
`invalid_token`, `invalid_dpop_proof`; `403 identity_required`;
`404 not_found`, `unknown_app`; `409 session_exists` (with the existing
`sessionId`), `run_active`, `app_not_ready`, `not_running`, `not_suspended`,
`session_busy`; `428 terms_required`; `429 too_many_sessions`,
`reload_rate_limited`; `500 run_failed`, `set_apps_failed`, `set_agent_failed`,
`session_store_failed` (the session record could not be written after retries; the session is `failed` with the store's error);
`503 identity_provider_unavailable`.

Telo versions are judged when an app set is created or replaced (`supplyTelo`,
and core's own `MIN_SUPERVISABLE_TELO` floor), since that is when an app's image
is chosen. An agent whose port an app declares is dropped with a notice on a
create, refused (`agent_port_conflict`) on `PUT …/agent`, and an app set
declaring the session's agent port is refused (`port_conflict`). So is an app
declaring a port the backend reserves for its own workload (`reservedPorts`),
on a create and on `PUT …/apps`, the refusal naming what binds it.

**Statuses.** A session is `starting`, `running`, `suspended`, `failed` or
`stopped` (deleted). Each app reports an `app` event: `{ app, state: "ready" }`,
`{ app, state: "running", runId }`, or `{ app, state: "ready", ended: { runId,
code?, signal?, reason? } }`. A generation's `run` event carries `trigger: run`
(a Run), `watch` (a file changed) or `manual` (a reload).

## Ownership

A create with no identity mints a **resume secret** (256 bits), answers it once
in the `201`, and stores only its SHA-256 as the owner. Every session route takes
it as `Authorization: Bearer <secret>`: none is `401 session_auth_required`, and
a session another credential owns answers the same `404` as one that does not
exist, so an id reveals nothing. A secret presented on a create is refused. The
credential check is one seam (`callerResolver`, `ServerDeps.resolveCaller`), and
an identity is one branch of it resolving to the owner `(iss, sub)`.

### Identity

| Setting | Meaning |
| --- | --- |
| `RUNNER_IDENTITY_AUDIENCE` | The runner's public https base URL, written canonically, with no query, fragment or trailing slash (`https://runner.example.com`, `https://example.com/runner`). The RFC 8707 resource, the expected `aud`, and the base of every DPoP `htu`. |
| `RUNNER_IDENTITY_ISSUERS` | Comma-separated https issuer identifiers whose access tokens the runner accepts, each compared to `iss` exactly. |

Both or neither: boot refuses one without the other, a non-https audience or
issuer, and an audience with a query, a fragment, a trailing slash or a
non-canonical spelling. With neither, the runner takes resume secrets only —
`telo runner`'s default, since a loopback http address cannot be an audience.

**Advertising.** `/v1/capabilities` carries `identity`, the RFC 9728
protected-resource metadata `{ resource, authorization_servers,
dpop_bound_access_tokens_required: true, dpop_signing_alg_values_supported:
["ES256", "EdDSA"] }`; core adds it to whatever the backend describes, and it is
absent without configuration. The same document is served at
`/.well-known/oauth-protected-resource` and, for an audience with a path, at the
RFC 9728 path with it inserted (`https://example.com/runner` →
`https://example.com/.well-known/oauth-protected-resource/runner`) — the
operator's proxy routes that URL to the runner. Every 401 carries
`WWW-Authenticate: DPoP algs="ES256 EdDSA", resource_metadata="<that URL>"`, with
`error` and `error_description` when a token or proof was refused (exposed to
browsers through CORS).

**A request** carries `Authorization: DPoP <access token>` and one `DPoP` proof
header. The access token must be a JWT with `typ: at+jwt`; signed with an
asymmetric `alg` by a key from the issuer's JWKS — found through RFC 8414
discovery (`/.well-known/oauth-authorization-server`, path-inserted), then OIDC
discovery (`/.well-known/openid-configuration`), whose `issuer` must match;
cached per issuer for ten minutes, refetched on an unknown `kid` at most every
30 s; from a configured `iss`; with `aud` containing the audience; within `exp`
(and `nbf` / `iat` when present) with 60 s of skew; with a non-empty `sub` and a
`cnf.jkt`. The proof (RFC 9449) must have `typ: dpop+jwt`, `alg` `ES256` or
`EdDSA`, an embedded public `jwk` whose RFC 7638 thumbprint is `cnf.jkt`, `htm`
equal to the request method, `htu` equal to the audience followed by the request
path (no query: a proof for `GET /v1/sessions?workspace=x` names
`<audience>/v1/sessions`), `iat` within 120 s, `ath` the base64url SHA-256 of the
token, and a `jti` not seen before — kept in the session store for the window and
purged on the lifecycle tick, so a replay is refused across a restart. Scope and
`client_id` are not judged. Refusals are `401 invalid_token` /
`invalid_dpop_proof`. An issuer whose keys cannot be fetched, with no cached set,
answers identity requests `503 identity_provider_unavailable`; a stale cached set
keeps answering while a refresh fails, and resume-secret requests are unaffected.

**Identity routes.** A create by an identity is owned by `(iss, sub)` and
answers no secret. `GET /v1/sessions` lists the caller's sessions; with a resume
secret it is `403 identity_required`, with no credential `401`.
`POST /v1/sessions/:id/owner` adopts a resume-secret session: `Authorization`
carries the identity, so the secret travels in the body as `{ resumeSecret }`. A
wrong secret, or a session it does not own, is `404`; an identity that already
has a session for that `workspace` is `409 session_exists` with that session's
`sessionId`.

**The byte channel takes a ticket**, because a browser cannot set a header on a
WebSocket upgrade: `POST …/io-tickets` mints one for an app, single use, valid
30 s, and `/io?ticket=<ticket>` redeems it. No credential appears in a URL.
Close codes: `4401` no ticket; `4403` a ticket unknown, used, expired or minted
for another session, or an origin the runner does not serve; `4404` the session
or app is gone; `4410` the session ended with nothing left to replay.

## Lifecycle

Every record change is written to the store before the live entry or the event
stream shows it. At boot the runner loads every record; a `running` one is
adopted when the backend still holds its workload (`adopt`) and `suspended`
otherwise, and the backend's sweep then removes what the store does not know,
sparing every known session's storage and every adopted workload. A session
suspends with no subscriber for `RUNNER_SESSION_IDLE_SECONDS`, after
`RUNNER_SESSION_MAX_RUNNING_SECONDS` running (counted from when this runner
process saw it running), or on `POST …/suspend`; `resume` rebuilds the workload
with every app `ready`. A `failed` session keeps its storage and resumes too. A
suspended or failed session is deleted with its storage after
`RUNNER_SESSION_RETENTION_SECONDS`. Closing the runner detaches every workload
and stops nothing that outlives the runner.

## The session config belongs to the runner

`SessionConfig` is an opaque bag. It used to declare `image` and `pullPolicy`,
which is container vocabulary — invisible only while every backend ran
containers, and wrong for one that runs local processes. A runner describes its
own editable fields through `config.schema` on `/v1/capabilities`, which is what
the editor renders the form from, and enforces the same through `validateConfig`
against a client that skipped the editor. The container backends narrow the bag
with `containerConfig` / `validateContainerConfig`, which live here because both
of them need exactly the same two fields.

A narrowed `corsOrigins` is enforced by the runner too, not just handed to the
browser: a request carrying an origin the runner does not serve is refused
(`403 origin_not_allowed`), because CORS only governs what a browser hands back
to a page. A request with no origin is left alone — every CLI and health check
sends none — while the byte channel refuses a missing one, since a browser
always sends it on an upgrade.

`features.io` is enforced the same way: the modes a runner advertises are the
modes a Run accepts, and one it does not serve is refused with `io_unsupported`
rather than downgraded — `isatty()` is observable to the application.

## Workload tokens

The co-resident agent (`AGENT_*`, advertised as `features.agents`) may set
`AGENT_TOKEN_ENV`: for every workload created with that agent — a create,
a resume, an agent change — core mints a token (the session-id generator at 32
characters), injects it into the agent's operator env under `tokenEnv`, so no
other container sees it, and reports it as `RunnerEndpoint.token` on
`status.agent`. The store never holds it; an adopted workload's token is read
back by the backend. An `AGENT_TOKEN_ENV` that `AGENT_ENV` also sets is a
`RunnerConfigError` at boot. Core reports it, not the backend, so no
backend can publish an endpoint without the token its workload holds.

## The session store

A session's record is durable: `SessionStore` keeps it, and `openSessionStore`
opens the one the configuration names. A record holds the session id, its owner
(an identity `(iss, sub)` or the SHA-256 of a resume secret), the client's
`workspace` name, the agent choice, the app set (names, entries, ports, telo
versions), the session config, the status, and its created, last-active and
suspended times — never session env, workload tokens or an agent's operator env.
One owner holds at most one session per `workspace`; a second create answers
`{ kind: "exists", id }` with the existing session's id. The store also keeps the
DPoP proof `jti`s it has seen until each expires, so a replay is refused across a
restart.

| Setting | Meaning |
| --- | --- |
| `RUNNER_SESSION_STORE` | `sqlite` (default) or `postgres`; anything else refuses to boot. |
| `RUNNER_SESSION_STORE_URL` | The Postgres connection URL. Required with `postgres`, refused with `sqlite`. |
| `RUNNER_STATE_DIR` | The runner's own state directory; the SQLite store is `sessions.sqlite` in it. The container runners require it with `sqlite`; the local runner falls back to its own state root. |

SQLite is Node's built-in `node:sqlite`; Postgres keeps its tables under the
`runner_` prefix. The schema is versioned (SQLite's `user_version`, Postgres's
`runner_schema_version`), each migration carries every existing record forward,
and a database a newer runner build migrated is refused rather than read.

## Session lifecycle settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `RUNNER_MAX_SESSIONS` | `8` | Most running sessions at once; suspended ones do not count. |
| `RUNNER_SESSION_IDLE_SECONDS` | `300` | No subscriber for this long suspends a session. |
| `RUNNER_SESSION_MAX_RUNNING_SECONDS` | `21600` | A running session suspends after this long. |
| `RUNNER_SESSION_RETENTION_SECONDS` | `2592000` | A suspended session is deleted after this long (30 days). |
| `RUNNER_SESSION_RELOAD_LIMIT` | `30` | Per-session reloads per minute. |

A runner started with a variable this release no longer reads refuses to boot,
naming each one and what replaced it: `RUNNER_WATCH_MAX_SESSIONS`,
`RUNNER_WATCH_IDLE_SECONDS`, `RUNNER_WATCH_MAX_TTL_SECONDS`,
`RUNNER_WATCH_SUSPENDED_TTL_SECONDS` and `RUNNER_WATCH_RELOAD_LIMIT` are renamed
to the settings above; `RUNNER_WATCH_SESSIONS`,
`RUNNER_WORKSPACE_CHECKPOINT_SECONDS`, `RUNNER_EXIT_TTL_MS`,
`RUNNER_MAX_TTL_SECONDS` and `RUNNER_APP_MAX_TTL_SECONDS` are removed.

## Session containers

With `RUNNER_SESSION_CONTAINERS=true` a runner serves every session a container
engine of its own, so a test that starts the database it needs
(`Container.Instance` over `Docker.Engine`) runs in a session unchanged:

| Setting | Meaning |
| --- | --- |
| `RUNNER_SESSION_CONTAINERS` | `true` to serve the engine; default `false`, and a session then gets nothing. |
| `RUNNER_SESSION_CONTAINERS_MAX` | Most containers one session may hold at once (default `4`); a create beyond it is `429`. |
| `RUNNER_INTERNAL_URL` | The runner's base URL as a session's workload reaches it (`http://runner:8061`). Required when the engine is on — the runner refuses to boot without it. |

Every Run's env gets `TELO_HOST_CONTAINER_ENGINE_URL`
(`<RUNNER_INTERNAL_URL>/v1/sessions/<id>/engine`) and
`TELO_HOST_CONTAINER_ENGINE_TOKEN`, a token minted for that session (a runner
restart mints a new one for new runs, and a run started before it that the new
runner adopts keeps its own — the store holds each token's SHA-256, never the
token). The engine
answers the Docker Engine API 1.41 requests `Docker.Engine` sends, at
`/v1/sessions/:id/engine/v1.41/…`, and refuses every other one:

- a request without the token is `401`, with another session's `403`;
- a create body may carry `Image`, `Cmd`, `Entrypoint`, `Env`, `User`,
  `ExposedPorts`, `Labels`, and `HostConfig.PortBindings` only as one
  `{ "HostIp": "127.0.0.1", "HostPort": "" }` per exposed port; anything else is
  a `400` naming the field (`HostConfig.Privileged`,
  `HostConfig.PortBindings.5432/tcp[0].HostPort`);
- every container is labelled `run.telo.session=<id>`, and inspect, logs, delete
  and list see only the session's own;
- nothing is published on a host: inspect answers each requested binding with
  the address the session reaches the container at and the container port;
- a session's containers are removed when it suspends, fails or is deleted,
  and when its app set or agent changes. A runner shutting down removes none:
  they are kept in the session's record, so a session whose workload the next
  runner adopts keeps them, and one it does not is suspended, which removes
  them; each backend's boot sweep removes what no live session holds.

A backend implements `RunnerBackend.containers` (`SessionContainerEngine`); a
runner turning the setting on over a backend without one refuses to boot.

## Public addresses — the host contract

An application declares every address it is reached at as a need —
`Telo.PublicUrl` for one address, `Telo.PublicHostPattern` for a family of
tenant hosts — each naming a port, and its `Http.Server` mounts route by them.
Whoever runs it is the **host** of those addresses: a runner, Telo Cloud, any
other platform. This is what every host does, stated once.

**Report mode** — the host supplies every address need itself:

1. It reads `telo needs report -o json`: each address need's type, its
   `parameters` (`port`, `primary`, `customDomains`) and the variable its field
   is read from. Nothing else about the application.
2. It gives each `Telo.PublicUrl` a URL colliding with no other, routes its host
   to the port and sets `url`; `primary` marks the need it gives its main
   address. How it names addresses is its own choice.
3. It gives each `Telo.PublicHostPattern` a pattern (`https://*.t.example` or
   `https://*-t.example`) colliding with no other, routes every matching host to
   the port and sets `pattern`.
4. It may route further domains, exact or `*.` wildcards, to the port of a
   `customDomains` need, supplying nothing for them.

**Template mode** — the host states its naming and the kernel derives each
address:

1. It sets `TELO_HOST_PUBLIC_URL_TEMPLATE`, and
   `TELO_HOST_PUBLIC_URL_SECONDARY_TEMPLATE` (holding `{label}`) when it can
   serve several addresses on one port. It reads nothing before boot.
2. It routes each host a port's `publicUrls` on `Kernel.PortsResolved` names to
   that port, again on every load. Core carries them on
   `PortMapping.publicHosts`.
3. It answers `Telo.PublicUrl` only, so it is a partial host: a pattern or a
   `customDomains` need comes from the session's env, whose author acts as its
   host.

**In both modes** the host routes without changing the request — the path
unchanged, `Host` as the client sent it — and never routes one hostname and port
to two ports; it supplies origins (a `url` is an origin, a `pattern` a pattern
origin); it owns TLS, certificates and DNS, so the application holds no
certificate and learns of a domain only through a fulfilment; it may redirect a
domain instead of routing it; and it leaves unsupplied any need it cannot serve,
which the kernel refuses as `ERR_NEED_UNMET`, naming the variable.

**A set of host values serves exactly one root application.** A host running
several applications gives each its own, and a child an application starts with
`App.Instance` inherits none of them. The derivation rules are in the guide
*Providing needs*; the routing an application declares in `http-server`'s
host-routing doc.

Which mode each runner is: the k8s runner is a template-mode host on a routed
session; the docker runner and the local-process runner set no template, so
every address need comes from the session's env.

## Two nouns, one stream

`status` is the SESSION's state; `run` is one application's outcome. They are
separate because a session outlives its runs: a one-shot Runnable finishing
emits `run` with `phase: "completed"` and leaves `status: running`.

Workload output travels neither — it goes over the byte channel (`/io`), which
exists precisely because per-chunk events are wasteful for high-volume output.
The `stdout` / `stderr` `RunEvent` variants that used to be declared here were
emitted by nothing; they are gone rather than qualified.

## Development

```bash
pnpm --filter @telorun/runner-core build
pnpm --filter @telorun/runner-core test
pnpm --filter @telorun/runner-core build:supervisor --target x86_64-unknown-linux-musl
```

The supervisor tests build the crate with cargo (or run `TELO_SUPERVISOR_BIN`)
and are skipped, naming why, off Linux or without either.
