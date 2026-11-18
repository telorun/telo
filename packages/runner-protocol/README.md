# @telorun/runner-protocol

The client-facing `/v1` contract of a Telo **runner**: the HTTP and SSE routes a
client (telo studio, the CLI, any tool) speaks to a runner, the events its
sessions stream, the byte channel's close codes, the error shape and the share
routes. A runner is the service that hosts a workspace and runs applications in
it; one contract is served by every runner backend.

This README is the specification. [`runner-protocol-schema.json`](./runner-protocol-schema.json)
holds every request, response, event and error shape (and `x-telo-routes`, the
route table naming each route's request and answers), and the TypeScript types in
`src/index.ts` mirror it. The package has no dependencies and no runtime logic.

Out of scope, specified elsewhere:

- the Docker Engine API subset served at `/v1/sessions/:id/engine` to a session's
  workload (the Engine API 1.41 subset `Docker.Engine` sends) — referenced, not
  restated;
- the debug frames carried by `debug` events — the debug wire format,
  `@telorun/debug-wire`;
- the tunnel a shared run connects to — specified by `@telorun/share-tunnel`
  ([`specs/tunnel-protocol.md`](../share-tunnel/specs/tunnel-protocol.md)).

## Conventions

- JSON bodies, `Content-Type: application/json`. **Every response and event
  shape is closed**: a runner answers no member the schema does not list, so a
  client may reject one. A client must ignore an event `type` it does not know.
- Timestamps are RFC 3339 strings.
- **Errors** are `{ "error": "<code>", "message": "<words>" }` with the HTTP
  status of the refusal, and may carry further members (`409 session_exists`
  carries the existing `sessionId`; `telo_version_unavailable` carries `app`,
  `version`, `reason`). `428 terms_required` is `{ "error": "terms_required",
  "terms": { version, title, body } }`.
- A session another caller owns answers the same `404 not_found` as one that does
  not exist.

## Credentials

Every session route takes the caller's credential, which names the **owner**:

- **A resume secret**: `Authorization: Bearer <secret>`. A create with no
  credential mints one (256 bits) and answers it once as `resumeSecret`; it names
  that one session.
- **An identity**: `Authorization: DPoP <access token>` plus one `DPoP` proof
  header (RFC 9449), accepted only by a runner that advertises `identity` on
  `/v1/capabilities`. The access token is an RFC 9068 JWT whose `aud` contains
  the runner's `identity.resource`; the proof has `htm` equal to the method, `htu`
  the URL the request was sent to without query or fragment, `ath`, a fresh
  `jti` and `iat` within 120 s. A client checks `identity.resource` against the
  URL it connects to and never takes it from the runner.

No credential is `401 session_auth_required`; a refused token or proof is `401
invalid_token` / `invalid_dpop_proof` with `WWW-Authenticate: DPoP …`; an issuer
the runner cannot reach is `503 identity_provider_unavailable`. A route only an
identity may use answers a resume secret `403 identity_required`.

## Discovery and health

| Route | Answer |
| --- | --- |
| `GET /v1/health` | `200 { ok: true, version }` — the runner's own version. |
| `GET /v1/capabilities` | `200` `RunnerCapabilities`: `displayName`, `description`, `config.schema` (a JSON Schema of the editable session config, plus `config.supersededByTelo`), `features`, optional `terms` and `identity`. |
| `GET /.well-known/oauth-protected-resource` | `200` the same `identity` document (RFC 9728), on a runner that accepts identity; also at the path-inserted form for an audience with a path. |
| `POST /v1/probe` | `{ config? }` → `200` `AvailabilityReport`: `{ status: "ready" }`, `{ status: "needs-setup", issues }` or `{ status: "unavailable", message, remediation? }`. |

`features` lists what the runner enforces: `io` (byte-channel modes `tty` /
`streams`; a Run asking for another is `400 io_unsupported`, never downgraded),
`ports`, `agents` (the one co-resident agent it names; another is `400
unknown_agent`), `teloVersions` (an application's `telo` is honoured or refused,
never substituted; absent, a request naming one is `400 telo_version_unsupported`)
and `shares`.

`terms`, when present, must be accepted: `POST /v1/sessions` carries
`x-telo-accepted-terms: <terms.version>`, else `428 terms_required`.

## Sessions

A session is a workspace: one workload with one idle slot per application,
started by Run. Its `status` is `starting`, `running`, `suspended`, `failed` or
`stopped`; `stopped` and `failed` end the event stream, and `suspended` keeps the
record and storage so `resume` rebuilds it under the same id.

| Route | Request → answer |
| --- | --- |
| `POST /v1/sessions` | `CreateSessionRequest { workspace, agent?, apps, config? }` → `201 { sessionId, streamUrl, createdAt, resumeSecret? }`. One session per owner and workspace: a second is `409 session_exists`. A resume secret on a create is `400 resume_secret_on_create`. |
| `GET /v1/sessions` | Identity only. `?workspace=` optional → `200 { sessions: [{ sessionId, workspace, status, lastActiveAt }] }`, newest activity first. |
| `GET /v1/sessions/:id` | `200` the session document: `sessionId`, `workspace`, `status`, `agent` (name or `null`), `config`, `apps` (each `name`, `entryRelativePath`, `ports`, `telo?`, `state` `pending`/`ready`/`running`, `runId?`, `io?`, `generation`), `createdAt`, `lastActiveAt`, `suspendedAt` (or `null`). |
| `DELETE /v1/sessions/:id` | `204`. Deletes the workload, storage and record. |
| `POST /v1/sessions/:id/owner` | Identity only. `{ resumeSecret }` → `200 { sessionId }`: the owner becomes the identity and the secret stops working. A wrong secret is `404`; an identity already holding the workspace is `409 session_exists`. |
| `PUT /v1/sessions/:id/apps` | `{ apps }` → `202 { apps: [<name>] }`. |
| `PUT /v1/sessions/:id/agent` | `{ name }` (one of `features.agents`) or `{ name: null }` → `202 { agent }`. |
| `POST /v1/sessions/:id/apps/:app/run` | `{ env, io, cols?, rows? }` → `202 { runId }`. |
| `POST /v1/sessions/:id/apps/:app/stop` | `202 { runId }`, `{ runId: null }` when nothing was live. |
| `POST /v1/sessions/:id/reload` | `?app=` optional (every app otherwise) → `202 { reloaded: [<name>] }`. |
| `POST /v1/sessions/:id/suspend`, `…/resume` | `202 { sessionId }`. |
| `POST /v1/sessions/:id/io-tickets` | `{ app }` → `201 { ticket, expiresAt }`. |

An app is `{ name, entryRelativePath, ports?, telo? }`: `name` a DNS label of at
most 63 characters unique in the session, `ports` `{ port, protocol: tcp|udp,
publicHosts? }` unique across the whole session, `telo` a plain release version
(every app names one, or none does).

Refusals by status: `400` `invalid_app_name`, `reserved_app_name`,
`duplicate_app_name`, `invalid_entry`, `port_conflict`, `invalid_telo_version`,
`telo_version_unsupported`, `telo_version_unavailable`, `invalid_config`,
`unknown_agent`, `agent_port_conflict`, `io_unsupported`, `invalid_path`,
`resume_secret_on_create`, `origin_not_allowed` (403); `401` `session_auth_required`,
`invalid_token`, `invalid_dpop_proof`; `403 identity_required`; `404` `not_found`,
`unknown_app`; `409` `session_exists`, `run_active`, `app_not_ready`, `not_running`,
`not_suspended`, `session_busy`; `428 terms_required`; `429` `too_many_sessions`,
`reload_rate_limited`; `500` `run_failed`, `set_apps_failed`, `set_agent_failed`,
`session_store_failed`; `503 identity_provider_unavailable`.

## Events

`GET /v1/sessions/:id/events` is `text/event-stream`. Each message's `id` is the
replay cursor (resume with `Last-Event-ID` or `?lastEventId=`) and its `data` one
`RunEvent`, discriminated by `type`:

- `status { status }` — the session's status; `running` carries `endpoints?`,
  `inspectUrl?` and the co-resident `agent?` endpoint.
- `progress { app?, phase: build|provision|boot, message, done? }`.
- `debug { app, frame }` — a frame of the app's kernel debug stream, relayed
  unjudged (a frame over 1 MiB is relayed as a stand-in carrying its name,
  timestamp and size).
- `app { app, state: ready|running, runId?, ended? }` — one app's slot; `ended`
  is `{ runId, code?, signal?, reason? }`.
- `run { app, generation, phase: started|completed|failed, … }` — one
  generation of one process: `started` carries `trigger` (`run` / `watch` /
  `manual`) and the runtime's reported `telo?`; `completed` carries `code` and
  `durationMs?`; `failed` carries `reason`.
- `openUrl { app, generation, url, reach: port|unrouted|external, port? }` — the
  app asked for a page; the runner never builds an address a client opens.
- `reachability { app, port, state: checking|reachable|unreachable }`.
- `route { app?, host, port, state: pending|programmed|unprogrammed, reason? }`.
- `endpoints { app, added?, removed?, rejected? }` — an app's declared port set
  changed.

Workload output never travels this stream.

## Workspace

| Route | Request → answer |
| --- | --- |
| `GET /v1/sessions/:id/workspace` | `200 { files: [{ path, hash }] }` — `hash` the sha256 of the bytes. |
| `POST /v1/sessions/:id/workspace` | `{ write?: [{ path, content, encoding?: utf8\|base64 }], delete?: [<path>] }` → `200 { written, deleted }`. |
| `GET /v1/sessions/:id/workspace/file` | `?path=` → `200 { content, size }`. |

All three answer `409 not_running` while the session has no live workload;
`invalid_path` refuses a path that leaves the workspace.

## The byte channel

`GET /v1/sessions/:id/io?app=<name>&ticket=<ticket>` upgrades to a WebSocket. A
ticket is single use, valid 30 s, minted by `POST …/io-tickets`; no credential
appears in a URL. Every server frame is `[seq:4 BE][stream:1][payload]`, with
`stream` `0` (tty), `1` (stdout) or `2` (stderr). Close codes: `4401` no ticket;
`4403` a ticket unknown, used, expired or minted for another session or app, or an
origin the runner does not serve; `4404` the session or app is gone; `4410` the
session ended with nothing left to replay.

## Shares

A share is a stable public address for a run on the caller's own machine. It is
the caller's until deleted. These routes are offered only by a runner whose
`features.shares` is present, `{ maxPerOwner, maxConnectedPerOwner,
retentionSeconds }`, and take an identity.

| Route | Request → answer |
| --- | --- |
| `POST /v1/shares` | `{ name, application }`, get or create by `name` → `201` when new, `200` when it exists: `{ id, name, application, publicUrlTemplate, publicUrlSecondaryTemplate, tunnelUrl }`. The templates are handed to the kernel verbatim; `tunnelUrl` is the `wss://` tunnel endpoint. |
| `GET /v1/shares` | `200 { shares: [{ id, name, application, connected, lastActiveAt }] }`, newest activity first. |
| `DELETE /v1/shares/:id` | `204`, or `404 share_not_found` for an unknown, deleted or another owner's id. |

An owner at `maxPerOwner` gets `429 too_many_shares`; a resume secret gets `403
identity_required`. `name` and `application` are at most 512 characters. The
tunnel's close codes and control messages are specified by `@telorun/share-tunnel`
([`specs/tunnel-protocol.md`](../share-tunnel/specs/tunnel-protocol.md)), not here.

## Changing the contract

A change to a route, a member, a status or a code is made here — this README, the
schema and the types together — and runner-core's tests hold every answer it serves
to the schema. A member a runner newly answers must be added to the schema first.
