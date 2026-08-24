# Local Runner Supervisor — retire the Tauri runner

## Problem

The editor has three ways to run an Application, but only two runner implementations should exist. docker-runner and k8s-runner already share one stack: `@telorun/runner-core` on the server (the `/v1` HTTP + SSE + WebSocket contract — sessions, probe, capabilities, io, terms) and one client adapter factory (`src/run/adapters/http-runner/factory.ts`). The Tauri "Local (docker)" path is a full third implementation of the same concept: ~1,050 lines of Rust (`src-tauri/src/run/`) plus ~450 lines of TS (`src/run/adapters/tauri-docker/`) with its own wire protocol (Tauri events + IPC Channels).

The duplication has already produced drift. Relative to docker-runner, the Tauri path lacks:

- Progress phases (`build`/`provision`/`boot`), per-port reachability events, capabilities self-description, terms — runner-core features the Rust path never implemented and would have to re-implement to stay at parity.
- Robustness: the Rust path bind-mounts a host tempdir into the workload container (`-v <tmpdir>:/srv`), the classic Docker Desktop file-sharing failure on macOS/Windows. docker-runner's named-volume bundle flow avoids bind mounts entirely.

Feature parity in the other direction is complete: docker-runner does hijacked-attach PTY (`Tty: true`), resize, scrollback replay, `attach` after reload, and relays the `--inspect` debug stream over the session SSE stream — everything the Rust path does.

## Solution

Delete the Tauri runner implementation. Replace it with a small **local runner supervisor** in the Tauri shell that runs the published `telorun/docker-runner` image as a local container, and let the editor talk to it through the existing http-runner adapter stack. Docker is already the hard requirement for local runs, so the runner-in-a-container adds zero new prerequisites.

Decisions already made:

- **Lifecycle: kill on close.** Editor quit stops the local runner container (its SIGTERM handler stops all sessions) and cleans up everything it created, best-effort.
- **Explicit start.** The runner never starts implicitly — not on app launch, not on probe, and not as a side effect of pressing Run. The user starts it from a button that explains the consequences; anything that needs the runner while it's down points at that button.
- **No remote `DOCKER_HOST` support.** The supervisor targets the default local daemon only. Users with a remote daemon deploy docker-runner there themselves (per its README) and add it as a custom HTTP runner — that path already exists.
- **No auth.** The runner API binds `127.0.0.1` only, unauthenticated — same trust level as the docker socket it fronts, and the documented docker-runner standalone posture.

### Rust supervisor (`src-tauri/src/local_runner.rs`, replaces `src-tauri/src/run/`)

State: a managed `LocalRunnerState` holding the container name (`telo-local-runner`), the picked host port, and the resolved `baseUrl` — surviving webview reloads because it lives in the Rust process.

Commands:

- `local_runner_probe()` → `AvailabilityReport`. Docker CLI present + daemon reachable (salvaged from today's `availability.rs`, minus the image checks — session-image availability is now the runner's own `/v1/probe`, which the http adapter already calls).
- `local_runner_status()` → `{ state: "stopped" | "starting" | "ready", baseUrl? }`. Pure read of the supervisor state (plus a container-exists check to notice an externally killed runner); drives the start/stop UI and the adapter without side effects.
- `local_runner_ensure()` → `{ baseUrl }`. Invoked **only by the user's Start action**, never by the adapter. Idempotent bring-up:
  1. Probe docker; fail with the probe's remediation message if unavailable.
  2. `docker volume create telo-local-runner-bundles` (idempotent).
  3. If a `telo-local-runner` container exists: adopt it when it is running and its image matches the pinned tag; otherwise `docker rm -f` it (stale leftover from a crashed editor or an older editor version) and recreate.
  4. Create: `docker run -d --rm --name telo-local-runner -v /var/run/docker.sock:/var/run/docker.sock -v telo-local-runner-bundles:/bundles -e BUNDLE_VOLUME=telo-local-runner-bundles -e RUNNER_CHILD_NETWORK=bridge -p 127.0.0.1:<freeport>:8061 <pinned image>`. When the host environment has `OPENAI_API_KEY`, pass it through (`-e OPENAI_API_KEY`) so the local runner advertises `authoringAgent` and the agent works locally.
  5. Poll `GET /v1/health` until ready (bounded), then return the baseUrl.
- `local_runner_teardown()` — `docker rm -f telo-local-runner` (`--rm` makes kill sufficient, `rm -f` covers both), then best-effort `docker volume rm telo-local-runner-bundles`. Wired to `WindowEvent::CloseRequested` (replacing `kill_all_on_close`) and exposed as a command so settings can offer a manual reset. Never touches the `bridge` network (pre-existing, shared).

Killing the runner container is enough to kill workloads: docker-runner's shutdown path (`stopAllSessions`) mops up its child containers, and children are `--rm` siblings, so nothing lingers. The bundle volume is recreated on next `ensure`, so removing it on quit is pure cleanup, not state loss.

**Image pinning:** a build-time constant in the editor, generated from `apps/docker-runner/package.json` version at editor build (the publish workflow tags `telorun/docker-runner:<version>` whenever that version moves). Dev builds fall back to `telorun/docker-runner:latest`. The adopt-or-recreate step above is what upgrades the container when the editor updates.

### Editor adapter (`src/run/adapters/local-docker/`)

A thin wrapper around the shared factory, not a new protocol. It delegates every wire concern to `createHttpRunnerAdapter` and differs only in where `baseUrl` comes from:

- `id: "local-docker"`, registered only under Tauri (same gate as tauri-docker today).
- Config schema: the docker-runner session config the user already edits via fetched capabilities (image, pullPolicy, registryUrl) — no `baseUrl` field; it is supervisor-managed and injected per call.
- `isAvailable`: `local_runner_probe` first (docker missing/daemon down → that report, without starting anything). Docker fine but runner `stopped` → `needs-setup` with a "local runner is not running" issue, which the UI renders as the Start button (below). Runner `ready` → delegate to the inner adapter's health/probe.
- `start`: `local_runner_status()`; when `ready`, delegate to the inner adapter with the reported baseUrl. When not, fail with an actionable error pointing at the Start button — pressing Run never boots the runner.
- `attach`: if the supervisor reports the runner up, delegate; otherwise return `null` (kill-on-close means sessions never outlive the editor, so a fresh launch correctly marks old history entries unavailable).
- `fetchCapabilities` / `getTerms`: delegate when the runner is up; return `null` when it isn't (fall back to the static schema rather than booting a container to render a settings form).

### Start/stop UI

The local runner gets an explicit consent gate, riding the surfaces that already render `AvailabilityReport`s (runner settings + the run view's unavailable state):

- **Start local runner** button, shown wherever the local runner reports the "not running" state. Before anything runs, it states the consequences in plain terms: the editor will pull the `telorun/docker-runner:<pinned>` image (first start only), start a container **with access to your Docker daemon** (it mounts `/var/run/docker.sock` and can create containers on this machine), expose its API on `127.0.0.1` without authentication, and stop + remove everything when the editor quits.
- Pressing it invokes `local_runner_ensure` and shows progress (the first-start image pull can take a while), then re-probes so the runner flips to ready in place.
- **Stop local runner** counterpart (settings) invokes `local_runner_teardown` — stops all local sessions, removes the container and bundle volume.
- The decision is per editor session by design (kill-on-close means every launch starts from `stopped`); an "auto-start on launch" preference is out of scope for v1.

### Seeding & migration (`src/run/runners.ts`, `src/run/registry.ts`)

- `localDockerRunner()` seeds `adapterId: "local-docker"`. Carry over a persisted tauri-docker config's `image`/`pullPolicy`; drop `dockerHost`.
- `normalizeRunnerSettings` migrates an existing `LOCAL_DOCKER_RUNNER_ID` instance with `adapterId: "tauri-docker"` in place (same id, new adapterId + mapped config), so `activeRunnerId` keeps pointing at it.
- Old run-index entries recorded under the tauri adapter re-attach through the new adapter and resolve to `null` — kept as history, marked unavailable, matching the existing session-eviction UX.

### Deletions

- `src-tauri/src/run/` — `docker.rs`, `session.rs`, `bundle.rs`, `availability.rs` (probe logic moves into the supervisor), `mod.rs` with all `run_*` commands; `lib.rs` command registration updated.
- `src/run/adapters/tauri-docker/` — adapter, io-client, protocol, session-id, config-schema.
- The `RunEvent` "debug frames sourced two ways" special case collapses: all adapters now receive debug frames relayed over the session SSE stream.

## Out of scope

- k8s-runner: untouched. End state is exactly two runner implementations (docker, k8s), both behind runner-core, one editor wire adapter.
- Runner API auth, remote daemon support, keeping sessions alive across editor restarts — all explicitly decided against for v1.
- Browser (non-Tauri) editor behavior: unchanged; the local runner simply isn't seeded there, as today.

## Verification

- `runners.test.ts`: seeding + migration cases (tauri-docker → local-docker in place, dockerHost dropped, active id preserved).
- Manual, consent flow: fresh launch shows the runner as not running with the Start button + consequence copy; Run without starting fails with the pointer, never boots a container; Start pulls/boots and flips to ready; Stop tears down container + volume.
- Manual, desktop build: fresh machine path (no image → pull → run), run with ports + terminal input + debug panel, webview reload re-attach, editor quit removes `telo-local-runner` and the bundle volume, stale-container adoption after a forced kill, docker-daemon-down probe message, agent launch against the local runner with `OPENAI_API_KEY` set on the host.
