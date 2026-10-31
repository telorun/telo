# Durable workspace sessions

## Goal

**Before:** Studio creates a runner session as a side effect of Run, or of the agent launching. A session needs at least one application. Every application starts as soon as the pod is up. The session registry and the workspace checkpoint live in runner memory, so a runner restart answers `404`. Every volume of the pod is an `emptyDir`. The agent keeps its database, journal, revert copies and attachments in `/workspace/.telo-agent` on that `emptyDir`, so conversations die with the pod and the runner. Besides watch sessions, the runner serves one-shot `run` sessions and catalog app sessions (`POST /v1/apps/:name/sessions`).

**After:**
- **Opening a workspace is the explicit act that creates a session.** You pick one of three modes.
- **A session is a workspace.** It lives in a durable record and on durable storage, on every runner (k8s, docker, and the local runner Studio desktop ships).
- **The pod is ready for every Application in the workspace,** with one idle container each. An app runs only when Run is pressed: Run is a process start inside a container that already exists.
- **Suspending deletes the pod and keeps everything else.** Resuming rebuilds the pod under the same id, from any device the owner signs in on.
- **The agent's state lives on the session's durable storage,** outside the workspace tree, so conversations survive suspend, resume, app-set changes and runner restarts.
- **One-shot `run` sessions and catalog app sessions are removed.**

## Workspace modes

Studio asks for the mode the first time a workspace opens. It remembers the answer per workspace, and the workspace menu changes it.

| Mode | Runner session | Run | Agent |
|---|---|---|---|
| **Agent** | yes, with the `agent` container | yes | yes |
| **Manual** | yes, no agent | yes | hidden |
| **Only on this device** | none | hidden | hidden |

- **Only on this device** contacts no runner: no capabilities fetch, no probe, no run dock. The agent panel, its toggle and every entry point into the composer ("Fix with AI", "Ask AI", "Explain this failure") are hidden by the gate that already hides them where the panel is not offered. Language tooling is unaffected: engines still download and the hub is still asked.
- **Manual** hides the agent the same way.
- **Switching modes:**
  - Into Agent or Manual: creates or resumes the workspace's session.
  - Between Agent and Manual: changes the session's agent, which recreates the pod.
  - To Only on this device: suspends the session, which is kept until retention removes it.
- **A request typed on the closed-workspace screen** opens the workspace in Agent mode, because the request is for the agent.
- **A user-set agent URL** (the settings override) still applies in Agent mode, instead of the co-resident agent.
- **Storage:** the mode, the runner and the session id are kept in `localStorage` under `telo-studio:session:v1:<workspaceKey>`. Studio no longer launches a standalone agent.

## The session

A session is one pod (on the local runner, one directory and its processes):
- a `workspace` container;
- an `agent` container in Agent mode;
- one `app-<name>` container per Application.

An app container is ready but idle: its image is the app's telo version, already pulled; the workspace and the module cache are mounted.

**What recreates the pod** (the session id never changes):
- an Application added or removed;
- an app's telo version changed, since that changes its image;
- an app's declared ports changed;
- the agent choice changed.

**Statuses:**
- The session's `status` is `starting`, `running`, `suspended`, `stopped` or `failed`. `exited` is removed with one-shot sessions.
- Each app reports a new `app` event:
  - `{ app, state: "ready" }`: the container is up and nothing runs.
  - `{ app, state: "running", runId }`: a Run is live.
  - `{ app, state: "ready", ended: { runId, code?, signal?, reason? } }`: a run ended.
- `run` generation events are unchanged except `trigger`, which becomes `run` (Run pressed), `watch` (a file changed) or `manual` (`POST …/reload`). `initial` and `resume` are removed: neither the session coming up nor a resume starts anything.
- Reachability is reported for an app's ports only while that app runs.

**Routes.** Every session route requires the owner's credentials (Ownership, below).

| Route | What it does |
|---|---|
| `POST /v1/sessions` | Creates a session. Takes `{ workspace, agent?, apps, config? }`, and no files and no env. `workspace` is the client's opaque name for the workspace: a Telo Cloud working copy names its project, so it matches on every device; any other workspace is named by a per-device id. One session per owner and workspace: a second create answers `409 session_exists` with the existing id. A resume-secret create answers the secret once. |
| `GET /v1/sessions` | Lists the caller's sessions with their `workspace`, status and last activity. Identity callers only. |
| `GET /v1/sessions/:id` | The session record and its current status. |
| `DELETE /v1/sessions/:id` | Deletes the session, its pod and its storage. |
| `PUT /v1/sessions/:id/apps` | Replaces the app set. Each app is `{ name, entryRelativePath, ports?, telo? }`, with no `io`. |
| `PUT /v1/sessions/:id/agent` | `{ name }` (a catalog name from `features.agents`) or `{ name: null }`. |
| `POST /v1/sessions/:id/apps/:app/run` | `{ env, io, cols?, rows? }`. Starts the app. `409 run_active` while a run is live. |
| `POST /v1/sessions/:id/apps/:app/stop` | Ends the live run. A no-op when none is live. |
| `POST /v1/sessions/:id/reload` | Unchanged. |
| `POST /v1/sessions/:id/suspend` | Suspends now, without waiting for idleness. |
| `POST /v1/sessions/:id/resume` | Rebuilds the pod. Apps come back `ready`. |
| `POST /v1/sessions/:id/owner` | Adopts a resume-secret session for an identity (Ownership, below). |
| `POST /v1/sessions/:id/io-tickets` | Mints a ticket for the byte channel. |
| `GET /v1/sessions/:id/events`, `GET /v1/sessions/:id/io`, `…/workspace`, `…/workspace/file` | Unchanged in shape, authenticated as below. |

**Removed from the contract:**
- `mode`;
- `features.watch`;
- `bundle` and top-level `ports` / `telo` on a create;
- `POST /v1/apps/:name/sessions` and the `apps` list on `/v1/capabilities`;
- the checkpoint (whole-tree snapshots and re-seeding a resumed session from runner memory).

`RUNNER_APPS` stays: it is the agent catalog behind `features.agents`.

**A new session is empty.** Studio seeds it through `POST /v1/sessions/:id/workspace`, exactly as its sync already converges a workspace. What reaches the session is the opened workspace's tree, minus the sync's exclusions. A module importing a file outside the opened folder therefore cannot run in a session: Run is refused with a dock blocker naming the import. Today's "common ancestor" fallback is removed.

**Telo versions:**
- `SessionAppSpec.telo`, `features.teloVersions` and the `telo_version_unavailable` / `telo_version_unsupported` refusals keep their meaning.
- `MIN_SUPERVISABLE_TELO` rises from 0.121.0 to the release that carries the watch-mode change below, because reporting a finished one-shot run is part of what a runner asks of a telo. It is forward-declared and verified by execution once that release is published.
- They are judged when the app set is created or replaced, because that is when an app's image is chosen.

**A finished one-shot run reports its outcome.** `telo run --watch` takes no hold of its own. Each generation runs as a plain `telo run` would, to completion and teardown, and emits `Kernel.Stopped` with its exit code. The watch session then waits for the next change, kept alive by its file watchers and the `--inspect` endpoint. A one-shot app's generation therefore ends as `run` `completed` with its code, while the `app` stays `running` until Stop; the next edit starts generation N+1 with `trigger: watch`. A Service still holds the kernel itself and is unchanged. This changes `telo run --watch` for every CLI user: a finished app's resources are torn down when it finishes instead of being held until the next edit.

## Running an app: the session supervisor

**Every container app's main process is the runner's session supervisor.** It is a statically linked executable built by the runner's own release. It depends on nothing in the app image: no shell, no libc, no Node, no telo.

**Delivery:**
- **k8s:** an init container `supervisor`, on the runner's own image, copies the executable into an `emptyDir`. Each `app-<name>` mounts it read-only at `/opt/telo-runner` and runs `/opt/telo-runner/supervisor`.
- **docker:** the runner writes the executable at boot into a build-keyed directory of its own on its bundle volume. Each app container mounts it read-only at `/opt/telo-runner` and runs the same command.

**App container shape:**
- created with no TTY and no stdin;
- its stdout and stderr carry the supervisor's own log only;
- no session env, no `TELO_ENTRY`, no `TELO_INSPECT_ADDR`, no `CLICOLOR_FORCE`, and no `sh` wait loop.

**Supervisor env** (minted by the runner, never user env):
- `TELO_SUPERVISOR_LISTEN`: `0.0.0.0:<port>`, a distinct port per app container, because a k8s pod shares one network namespace.
- `TELO_SUPERVISOR_TOKEN`: one token per container, so code in app A cannot drive app B.
- The supervisor removes both from its environment before it starts anything, so no app sees them.
- Each app's supervisor and inspect ports are reserved: an app declaring one is refused like a port another app declares (`400 port_conflict`, or `rejected` on reload).

**Protocol** (generation 1):
- **Channel:** one WebSocket at `GET /v1/supervisor` on the listen address, `Authorization: Bearer <token>`. A missing token closes `4401`, a wrong one `4403`. Text frames are JSON control messages; binary frames are bytes in the byte channel's framing `[seq:4 BE][stream:1][payload]`.
- **`hello { generation }`:** both sides open with it, and the supervisor's also carries `state: idle | running` and the current `runId`. A generation mismatch means the pod predates this runner build, and the runner recreates the pod through the resume path.
- **Runner → supervisor:**
  - `run { runId, argv, env, cwd, io: "tty" | "streams", cols?, rows? }`
  - `stop { runId, graceMs }`
  - `resize { cols, rows }`
  - binary stdin frames
- **Supervisor → runner:**
  - `started { runId }`
  - `exited { runId, code?, signal? }`
  - `failed { runId, reason }` (a spawn that never ran)
  - `refused { runId, code: "run_active" | "no_run" }`
  - binary output frames
- **Idempotent by `runId`:** a repeated `run` of the live run answers `started` again, and a `run` of another id while one is live is `refused run_active`. A repeated `stop` after `exited` answers the same `exited`.
- **Processes:** each run is its own process group. It gets a fresh pty under `tty` and pipes under `streams`, so a run that left the terminal in raw mode cannot affect the next one. Stop is SIGTERM to the group, then SIGKILL after `graceMs`. The supervisor reaps orphans as PID 1. Env lives only in the supervisor's memory and the child's environment. Input arriving while nothing runs is discarded.
- **A dropped control connection stops nothing.** The run continues, the supervisor keeps a bounded output ring keyed by `seq`, and a reconnecting runner resumes from `hello`.
- **The supervisor knows nothing about telo.** It runs the argv it is handed. `telo run --watch --no-input --inspect <addr> --no-open <entry>` stays runner-core's, gated by `MIN_SUPERVISABLE_TELO` as today, and runs the Node or Rust `telo` alike.
- **The spec:** the protocol is written once, normatively, with its generation, beside the `/v1` contract. Its messages are pinned by vectors both container backends' tests run.
- **One adapter, in runner-core.** The mapping from supervisor events to `/v1` app states (`started` → `running`; `exited` / `failed` → `ready` with `ended`; the lost-frames notice; the generation-mismatch test) lives in runner-core beside the supervisor client and is used by both container backends, which pass the label their messages name a container by. The protocol fake both runners' tests use is exported from a `@telorun/runner-core/test-support` entry, imported only by tests, and runs the protocol vectors.

**How Run works:**
1. The runner sends `run` with the argv above and the request's `env` and `io`.
2. It arms one `--inspect` relay for that run when it hears `started`. The relay's last event id starts fresh for each process, so a new kernel's `Kernel.Starting` is never skipped.
3. It ends the relay on `exited`.

Reload is still a touch of the entry manifest through the `workspace` container.

**A container that ends is never a run outcome.** With the supervisor as main process, an `app-<name>` container that terminates is a supervisor failure. It is reported as the session's infrastructure failure, naming the container.

**Retired wiring:**
- the attach permission and attach path for app containers;
- `tty` / `OpenStdin` on app containers;
- `io` as part of the pod's structure. It moves onto Run, so changing it no longer recreates the pod.

**The local runner has no containers and no supervisor.** Run spawns `telo run` in the session directory, with the same messages' meaning behind the same backend seam: one process group per run, the same stop discipline, the same `app` events.

## Durability

**The session record:**
- **Fields:**
  - id
  - owner: `(iss, sub)`, or the SHA-256 of the resume secret
  - `workspace`
  - agent choice
  - app set (names, entries, ports, telo versions)
  - config
  - status
  - created, last active and suspended times
- **What it never holds:** session env (it arrives with each Run and is held only in the process running the app), workload tokens (minted again for every pod), and the agent's operator env (read from `RUNNER_APPS` when a pod is created). The store holds no secret.
- **Where it lives:** `RUNNER_SESSION_STORE` is `sqlite` (default) or `postgres`, with `RUNNER_SESSION_STORE_URL` for Postgres.
  - **SQLite** sits in the runner's own state: a PVC the k8s chart gives the runner, the docker runner's data volume, the local runner's state root.
  - **The schema is versioned** and every migration carries existing records forward.
  - **The runner stays one replica.** Live byte channels, output rings and event streams are in-process; Postgres changes where the record lives, not how many runners serve it.
- **At boot** the runner loads every record into the registry. A pod or container of a known `running` session is adopted, and its supervisors are reconnected through `hello`. A workload the store does not know is removed, as the orphan sweep does today. A known `running` session whose pod is gone becomes `suspended`.

**Per-session storage:**
- **k8s:** one PVC per session, labelled with the session id and `RUNNER_MANAGED_BY`, owned by nothing the pod's deletion collects. Size `RUNNER_SESSION_STORAGE_SIZE` (default `5Gi`), class `RUNNER_SESSION_STORAGE_CLASS` (default: the cluster's default class).
  - It holds `workspace/`, mounted at `/workspace` as today, and `agent/` for the agent's state.
  - The `.telo` module cache under the workspace root lives on it too, so a resumed session starts warm.
  - Suspend deletes the pod and keeps the PVC; resume mounts the same PVC.
- **docker:** the session's directory on the bundle volume, which it already has, gains `agent/` beside `workspace/`. It is kept across suspend.
- **local runner:**
  - **The state root:** `--state-dir`, then `RUNNER_STATE_DIR`, then a per-user default placed by each platform's convention for application state: `$XDG_STATE_HOME/telo/runner` (`~/.local/state/telo/runner` when unset) on Linux, `~/Library/Application Support/telo/runner` on macOS, `%LOCALAPPDATA%\telo\state\runner` on Windows. Never the temp directory and never the CLI's cache root. A root that cannot be resolved or written refuses the start, naming `--state-dir` and `RUNNER_STATE_DIR`. The store (`<root>/sessions.sqlite`) and the session directories (`<root>/sessions/<id>/{workspace,agent}`, `0700`) always share that root; `RUNNER_STATE_DIR` means a runner's whole state directory on every runner. Studio desktop passes `--state-dir <app data>/runner`.
  - **Where a session lives:** its directory under the state root, kept across suspend, runner restarts and reboots. It is keyed by session id, no longer by the runner's process id.
  - **The startup sweep** removes only directories the store does not know.
  - **Restarts:** a local session never outlives the runner process. At boot every stored local session is `suspended`.

**Lifecycle:**
- **Suspend:** a running session suspends when it has had no subscriber for `RUNNER_SESSION_IDLE_SECONDS` (default 300), on `POST …/suspend` (Studio sends it when the workspace closes or switches to Only on this device), and when it has been running for `RUNNER_SESSION_MAX_RUNNING_SECONDS` (default 21600).
- **Resume:** Studio sends `resume` when the workspace opens again.
- **Retention:** a suspended session is deleted with its storage after `RUNNER_SESSION_RETENTION_SECONDS` (default 2592000, 30 days).
- **Ceiling:** `RUNNER_MAX_SESSIONS` (default 8) bounds running sessions; suspended ones do not count.

**Configuration renamed or removed:**
- `RUNNER_WATCH_SESSIONS` is removed: sessions are always on.
- `RUNNER_WATCH_MAX_SESSIONS` → `RUNNER_MAX_SESSIONS`
- `RUNNER_WATCH_IDLE_SECONDS` → `RUNNER_SESSION_IDLE_SECONDS`
- `RUNNER_WATCH_MAX_TTL_SECONDS` → `RUNNER_SESSION_MAX_RUNNING_SECONDS`
- `RUNNER_WATCH_SUSPENDED_TTL_SECONDS` → `RUNNER_SESSION_RETENTION_SECONDS`
- `RUNNER_WATCH_RELOAD_LIMIT` → `RUNNER_SESSION_RELOAD_LIMIT`
- `RUNNER_WORKSPACE_CHECKPOINT_SECONDS`, `RUNNER_EXIT_TTL_MS`, `RUNNER_MAX_TTL_SECONDS` and `RUNNER_APP_MAX_TTL_SECONDS` are removed with the checkpoint, one-shot sessions and catalog app sessions.
- `RUNNER_MAX_CPU` / `_MEMORY` / `_EPHEMERAL_STORAGE` size each app container, and `RUNNER_APP_MAX_CPU` / `_MEMORY` / `_EPHEMERAL_STORAGE` the agent container.
- **A runner started with a removed or renamed variable refuses to boot,** naming its replacement or saying it is gone.

**Docker without `Subpath`** (Engine API older than 1.45) refuses to boot, naming the Docker 26 requirement. Today it advertises `features.watch: false`, and with one session shape there is nothing left to degrade into.

## Agent state

- **The agent declares its state directory as a `Telo.DurableDirectory` need** (`access: single-writer`). The need's `env:` binds `AGENT_STATE_DIR`, so a standalone deployment keeps naming the directory itself.
- **Each runner sets `TELO_HOST_STATE_DIR` on the agent** to the session's `agent/` directory. The kernel then answers the need as `<state dir>/needs/<need path>` and hides the variable from controllers. On k8s that is a `subPath` mount of the session PVC outside `/workspace`.
- **The agent's image** sets `TELO_HOST_STATE_DIR=/var/lib/telo-agent`, so a container run on its own keeps working.
- **The `<WORKSPACE_DIR>/.telo-agent` default is removed.** The state is no longer part of the workspace tree, so nothing syncs it, and SQLite runs on the filesystem it was opened on.
- **The agent still refuses its own state directory wherever it is,** as today. The name-based `.telo-agent` exclusion stays in the agent's listing and in Studio's sync, because workspaces from before this change may still hold one.
- **The need is `agentState: { kind: Telo.DurableDirectory, parameters: { access: single-writer }, env: { path: AGENT_STATE_DIR } }`.** The app's `stateDir` variable is removed. The chat library declares the same need (`agentState`, `single-writer`) in place of its `stateDir` variable, and the app forwards its root need to it whole (`needs: { agentState: !ref agentState }`): an import's `variables:` cannot read a resource, so a need is the only way the directory crosses into the library.
- **The readiness probe** writes `.telo/agent-ready-probe` (inside the module cache directory, which every sync and listing already excludes) instead of `.telo-agent/ready-probe`, so it never creates `.telo-agent` in the workspace.

**A test hands a child application its needs.** The agent's tests start it as a child through `App.Instance`, which today takes only `variables`, `secrets` and `ports`. `App.Instance` gains `needs:`, keyed by the child's own need names, in the two forms an import's `needs:` already takes: a whole `!ref` to a parent need or fulfilment of the same type, or a field map (`needs: { agentState: { path: <dir> } }`).
- **At the child root** a need is answered, in order: supplied by name → environment (its `env:`-bound name or `TELO_NEED_…`) → host-value derivation (`TELO_HOST_STATE_DIR`) → `ERR_NEED_UNMET`. A by-name supply counts as a root supply, so a `supply: root` type is accepted.
- **Refusals in the child at boot:** a need name it does not declare (`ERR_MANIFEST_VALIDATION_FAILED`, naming the needs it does declare), some fields only (`ERR_NEED_PARTIALLY_SUPPLIED`), an unusable directory (`ERR_NEED_DIRECTORY_UNUSABLE`, naming the parent's `App.Instance`).
- **Checked before anything runs:** a new annotation, `x-telo-application-source`, on a field naming a child application's source, lists the sibling maps it feeds (`/variables`, `/secrets`, `/ports`, `/needs`). `telo check` follows `source:` and checks all four maps against what the child declares: an undeclared name is `APPLICATION_INPUT_UNDECLARED` at that key, a refused value `SCHEMA_VIOLATION`, a whole forward the parent's need cannot satisfy `NEED_FORWARD_INCOMPATIBLE`, an unresolvable or non-Application source the import-resolution codes at `source:`. The annotation is generic: any kind that supervises a child application may carry it. The kernel and `telo check` agree on the undeclared-name refusal (`tests/check-run-agreement.yaml`).
- **The seam:** the runtime seam's named inputs gain `needs` (fields keyed by need name; a forwarded fulfilment crosses as its fields). The controller protocol's `Runtime.Run.inputs` gains `needs`, which is protocol generation `telo-7`. The `app` module's `requires: telo:` rises to the release carrying it, verified by execution.
- **The agent's tests** each supply `needs: { agentState: { path: <scratch>/agent-state } }`, read `<scratch>/agent-state/agent.sqlite`, and assert their workspace (`<scratch>/workspace`) holds no `.telo-agent`. Tests that import the chat library directly supply its need: `needs: { agentState: { path: … } }`.

## Ownership and authentication

**Anonymous: a resume secret.**
- `POST /v1/sessions` with no identity answers a resume secret once; the runner keeps only its hash.
- Every route takes it as `Authorization: Bearer <secret>`.
- Studio keeps it in `localStorage` (inside the per-workspace entry) on the web build, and in the OS credential store through the shell on the desktop build.

**Signed in: identity, on a runner configured for it.**
- **Configuration:**
  - `RUNNER_IDENTITY_AUDIENCE`: the runner's public https base URL (no query, no fragment, no trailing slash). It is the RFC 8707 resource, the expected `aud`, and the base of every DPoP `htu`.
  - `RUNNER_IDENTITY_ISSUERS`: a comma-separated list of https issuer identifiers.
  - Boot refuses either without the other, a non-https audience or issuer, and an audience with a query, a fragment or a trailing slash.
  - With neither set, the runner takes resume secrets only. That is the default for `telo runner`, which is loopback http and so can never be an identity audience.
- **Advertising:** `/v1/capabilities` carries `identity`, an RFC 9728 protected-resource metadata object built from the same configuration: `resource`, `authorization_servers`, `dpop_bound_access_tokens_required: true`, and `dpop_signing_alg_values_supported` (`ES256`, `EdDSA`). The same object is served at `/.well-known/oauth-protected-resource`, with the path inserted for a runner mounted under a path. A 401 carries `WWW-Authenticate: DPoP resource_metadata="…"`. Without configuration `identity` is absent.
- **Each request** carries `Authorization: DPoP <access token>` and a `DPoP` proof.
- **The access token must be:**
  - a JWT with `typ: at+jwt`;
  - signed with an asymmetric `alg` by a key from the issuer's JWKS, found through RFC 8414 / OIDC discovery, cached per issuer, and refetched on an unknown `kid` with a rate limit;
  - from an `iss` that is exactly one of the configured issuers;
  - one whose `aud` contains the audience exactly;
  - within `exp` (and `nbf` / `iat` when present) with 60 s of skew;
  - one with a non-empty `sub` and a `cnf.jkt`.
- **The DPoP proof (RFC 9449) must have:**
  - `typ: dpop+jwt`;
  - a key whose thumbprint equals `cnf.jkt`;
  - `htm` equal to the request method;
  - `htu` equal to the audience plus the request path;
  - `iat` within 120 s;
  - `ath` equal to the token's hash;
  - a `jti` not seen before. Seen `jti`s are kept in the session store for the window, so a replay is refused across a restart.
- **Not judged:** scope and `client_id`. The audience is the delegation, and ownership is the authorization.
- **Refusals** are the standard `invalid_token` and `invalid_dpop_proof`. An issuer the runner cannot reach makes identity requests `503 identity_provider_unavailable`; resume-secret requests are unaffected. The owner is `(iss, sub)`.
- **Studio uses identity only when all of these hold:**
  - the user is signed in;
  - the runner's `identity.resource` equals the canonical https base URL Studio is connected to (Studio checks it and never takes it);
  - Studio's own issuer is in `authorization_servers`.

  Otherwise it uses a resume secret and says why, for example when the advertised audience does not match the address. This check is what stops a runner from advertising another runner's audience to collect a token that works there.

**Getting a runner token** (the holder of Studio's sign-in is the web build's same-origin server, or the desktop shell):
1. Studio makes one non-extractable WebCrypto ES256 key per sign-in on each installation, kept in the page origin's IndexedDB (database `telo-studio`, store `runner-dpop-key`, one record per signed-in subject), created on first use and deleted at sign-out together with the runner grants. It survives reloads, because DPoP binds a token request's refresh token to the same key as its access token, so the key must live as long as the refresh token it constrains. Both builds use the same mechanism.
2. For each token it signs a DPoP proof for the token request and passes it to the holder.
3. The holder requests the token from **that runner's own grant** — never from Studio's sign-in grant — for `resource=<runner URL>`, carrying that proof, so the runner grant's tokens are bound to the installation's key. Studio's sign-in grant is never presented with a runner proof.
4. Studio keeps the access token in memory only and asks for a new one 60 s before it expires. No refresh token reaches Studio's JavaScript.
5. When there is no grant for a runner yet, the holder authorizes that runner once, naming only that resource. It is silent for a runner the user's identity provider trusts first-hand; a runner someone else operates asks for consent once. On the desktop build, that one authorization opens the system browser once per runner. A runner-grant refresh refused (`invalid_dpop_proof`, `invalid_grant`) deletes that grant and authorizes the runner again, saying so; clearing site data therefore costs one re-authorization.
6. Studio's own sign-in is never changed by it, so adding a runner never forces a sign-in.

**Adopting:** when the user signs in, Studio sends `POST /v1/sessions/:id/owner` for each session this device holds a resume secret for, on a runner that accepts identity, presenting both credentials. The owner becomes `(iss, sub)`, the secret stops working, and Studio deletes it. Signing out leaves the sessions with their identity owner, and Studio forgets them on this device.

**Byte channel and event stream:**
- A browser cannot set `Authorization` or `DPoP` on a WebSocket upgrade, so `/io` takes `?ticket=` from `POST /v1/sessions/:id/io-tickets`: single use, valid 30 s, bound to the session and the app. Either credential mints one. A token never appears in a URL.
- The `/events` stream is read by a fetch-based SSE reader that sends the credentials as headers (the one the agent panel already uses), instead of `EventSource`.
- The origin allowlist (`RUNNER_CORS_ORIGINS`) stays as it is.

**Another owner's session answers `404`,** so an id reveals nothing. A missing credential is `401 session_auth_required`.

## Backends

- **k8s:**
  - per-session PVC, the supervisor init container, the reserved supervisor ports in the session NetworkPolicies, and adoption at boot;
  - the chart gains the runner's own PVC (for SQLite), `sessionStore.*`, `sessionStorage.*` and `identity.*` values, and the RBAC for PVCs;
  - attach permission for app containers is dropped;
  - the session containers' policies and pods keep following the session pod, removed on suspend as today.
- **docker:** the per-session `agent/` directory, the supervisor directory on the bundle volume, the `Subpath` boot refusal, and adoption at boot through the session label.
- **local runner (`telo runner`, and the Tauri sidecar):** the store in its state root, session directories kept by id, processes spawned per Run. It offers no co-resident agent (`features.agents` is empty, as today); a local agent catalog is Studio's separate plan, and its agent will run with `TELO_HOST_STATE_DIR=<state root>/sessions/<id>/agent`. Every local session becomes `suspended` at boot. The shell passes `--state-dir <app data>/runner`.

## Studio

- **On opening a workspace:**
  1. Read the mode.
  2. For Agent or Manual, find the session: the stored id, else `GET /v1/sessions` filtered by `workspace` for an identity, else create one.
  3. Resume it if it is suspended.
  4. Seed it through the sync.
  5. Send `suspend` on close.

  A stored id that answers `404` (retention removed it) means creating a new session and seeding it.
- **The app set** is every Application in the workspace, each with the telo version its module is edited against and the ports it declares. Studio sends `PUT …/apps` when that set changes, whoever changed it.
  - **While an agent turn runs,** the change waits for the turn to end, because recreating the pod would kill the agent mid-turn. The dock shows it as pending.
  - **Running apps:** apps that were running when the pod was recreated are started again by Studio with fresh env.
- **Run** reads the env files as today and sends `POST …/apps/:app/run`. An app not yet in the pod's set (still waiting for a turn to end) says so and runs once the set is applied. **Stop** sends `…/stop`.
- **Removed from Studio:**
  - creating a session on Run;
  - the standalone agent launch;
  - the one-shot path;
  - `mode` on the wire;
  - the closure-based run bundle.
- **Authentication:** as above. The resume secret is stored as above, and the runner token is kept in memory only.

## Docs and releases

- **Guides:** `packages/runner-core/CLAUDE.md` (session shape, suspension, env split — session env reaches an app only through Run and never appears in a pod spec — ownership, and `identity` under "Capabilities are enforced"), `apps/k8s-runner/CLAUDE.md` (PVCs, supervisor, adoption), `apps/studio/CLAUDE.md` (modes, the session per workspace, how the audience is derived and checked, where the DPoP key lives) and `apps/authoring-agent/CLAUDE.md` (state as a durable directory).
- **READMEs:** runner-core's README and both runner READMEs (every variable above), and the chart's values documentation.
- **Changesets:** `@telorun/runner-core`, `@telorun/k8s-runner`, `@telorun/docker-runner`, `@telorun/cli` and `@telorun/studio`, plus the authoring agent's release entry.

## Verify

- **Opening a workspace:** in Agent mode it gives a pod with `workspace`, `agent` and one idle `app-<name>` per Application, with no app running. Manual has no `agent`. Only on this device makes no request to any runner, as the browser's network log shows.
- **Run and Stop:**
  - Run starts the app in its existing container with no pod change, and its first generation carries `trigger: run`.
  - Stop ends it and the container stays `ready`.
  - Run, Stop, Run on an app pinned to the new `MIN_SUPERVISABLE_TELO` works on both container backends; an app pinned to 0.122.0 is refused `telo_version_unavailable`.
  - A one-shot app's generation ends as `run` `completed` with its exit code under `--watch`, and the runner e2e's one-shot app reaches it; a Service app still serves until a change or Stop.
  - Under plain `telo run --watch --inspect`, a script-only manifest emits `Kernel.Stopped` with its code, its resources are torn down, and the process stays up; editing the entry starts a new generation.
- **The pod spec,** read from the API, holds no session env, no `TELO_ENTRY` and no `sh`, and every app container runs `/opt/telo-runner/supervisor`.
- **Isolation:** a process in app A, or in the agent, connecting to app B's supervisor port without its token is closed `4401` / `4403`. App A's environment shows no supervisor variable.
- **Adding an Application while an agent turn runs** changes nothing until the turn ends. Then the pod is replaced under the same session id, the conversation is intact, and apps that were running come back.
- **Durability:** suspend, restart the runner, resume. Same id, same files, same conversations, warm module cache, on k8s, docker and the local runner. Restarting the runner while an app runs (container backends) leaves it serving, and the runner reconnects and can stop it.
- **Agent state:** it is under the session's `agent/` directory; `/workspace/.telo-agent` is never created and nothing syncs agent state. The agent run with only `TELO_HOST_STATE_DIR=/d` keeps its state at `/d/needs/agentState/agent.sqlite`; with neither variable it is refused `ERR_NEED_UNMET` naming `AGENT_STATE_DIR`. `telo needs report apps/authoring-agent` lists `agentState` with `access: single-writer`.
- **Child application inputs:** `telo check` on an `App.Instance` with an undeclared key under `needs:` reports `APPLICATION_INPUT_UNDECLARED` at that key, and `telo run` fails with the child's refusal. All the agent's chat tests pass with `AGENT_STATE_DIR` unset, and no scratch workspace contains `.telo-agent`.
- **Local state root:** on Linux with no `XDG_STATE_HOME`, `~/.local/state/telo/runner/sessions.sqlite` appears; `RUNNER_STATE_DIR=/x telo runner` puts both `sessions.sqlite` and `sessions/` under `/x`; with `HOME` unset the runner refuses to start, naming both settings; a session survives a reboot.
- **One supervisor adapter:** no runner package defines a supervisor adapter or a fake supervisor; changing a vector fails the fake's vector run; neither runner's built output contains the fake.
- **DPoP key across reloads:** desktop — sign in, get a runner token, reload the webview, get another: no browser opens and Cloud calls keep working. Web — the same, with no `invalid_dpop_proof`. Sign-out removes the key record and every runner grant.
- **Retention:** a suspended session past `RUNNER_SESSION_RETENTION_SECONDS` is gone with its storage, and Studio then creates a new session and seeds it.
- **Configuration:** boot refuses `RUNNER_WATCH_SESSIONS` (and each renamed variable) naming the replacement; `RUNNER_IDENTITY_ISSUERS` without `RUNNER_IDENTITY_AUDIENCE`; an http audience; and docker without `Subpath`.
- **Identity:**
  - A token minted for runner A presented to runner B: `401 invalid_token`.
  - A proof replayed against another URL: `401 invalid_dpop_proof`.
  - A token with no proof: 401 with `WWW-Authenticate: DPoP resource_metadata=…`.
  - A replayed `jti`, also after a runner restart: refused.
  - An unreachable issuer leaves resume-secret sessions working.
- **Studio's audience check:** a runner whose `identity.resource` differs from the URL Studio connects to gets no token. Studio falls back to a resume secret and says why.
- **Cross-device and adoption:**
  - Signed in on device A, open a Telo Cloud working copy, close it. Signed in on device B, open the same project: the same session resumes.
  - An anonymous session is adopted on sign-in, and its old secret answers `404`.
- **Byte channel:** a reused or expired ticket is refused, and no credential ever appears in a URL.
- **Removed routes:** one-shot and catalog app session routes answer `404`.
