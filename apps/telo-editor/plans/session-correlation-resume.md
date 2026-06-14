# Session correlation & resume

## Problem

A run started from the telo editor lives only in React state. A page reload wipes the run
list, and there is no way to reconnect to a session that is still running on a remote runner
or local docker container — even though the work keeps going on the other side. Users lose
visibility into in-flight and recently-exited runs the moment they refresh. We want runs to be
**resumable**: after a reload the run history reappears, and opening any entry restores its
console scrollback and inspection events (and, for a still-running session, live output and
interactive input).

## Solution

Persist a lightweight **session index** as the editor's durable read model, and re-fetch the
heavy data (logs, inspection events) from the owning runner on demand. The runner stays the
owner of history; the editor only remembers pointers.

- **Session index (editor).** A new localStorage key (`run-index.ts`) holds one pointer per run:
  `sessionId`, `appPath`, `adapterId` + display name, `hasTerminal`, `startedAt`, last-known
  `status`, and the adapter `config` used to start it (which carries the runner address needed to
  re-attach). No log or event bodies are stored. `status` is updated as status events arrive so
  the list is correct after a reload even before a session is opened. Maintained alongside the run
  lifecycle in `apps/telo-editor/src/run/context.tsx`.

- **Reload flow.** On load, rehydrate the run list from the index as empty `RunRecord` shells.
  Opening a session runs an **attach** path — factored out of today's start-then-stream code in
  the http-runner adapter so it can begin from an index entry, not only from a `POST` response.
  Attach first reconciles status, then replays from offset 0 for a full restore: SSE
  `?lastEventId=0` for status/progress/stdout/stderr/debug, and, when `hasTerminal`, WS
  `?lastSeq=0` for PTY scrollback plus live interactive reattach. If the runner reports the
  session is gone (HTTP 404 / container absent), the entry is marked "history unavailable" but
  kept in the list.

- **HTTP runners (k8s + docker-runner).** No new endpoint — the existing SSE/WS replay already
  returns console history and inspection events from offset 0. Two runner changes in
  `packages/runner-core`: the post-exit eviction TTL (`RUNNER_EXIT_TTL_MS`) goes from ~5 minutes
  to ~4 hours so an exited session survives long enough to reload; and the registry, when at
  capacity, evicts the oldest *terminal* session before rejecting a new run (with a higher
  `RUNNER_MAX_SESSIONS` default). The latter is required because a long TTL would otherwise let
  retained exited sessions exhaust the concurrent-session cap and 409 new runs.

- **tauri-docker (local), phase 2.** The container outlives a webview reload (the Rust process,
  and thus the `SessionRegistry`, survives), so re-attach is by `sessionId` from the index — no
  container enumeration needed. The fix is a Rust-side **output hub** (`session.rs`): the reader
  tasks push container bytes into a per-session hub for the workload's whole life, so the stdout
  pipe is never dropped on reload (which would SIGPIPE `docker run` and kill the container). The
  hub retains a capped transcript; `run_reattach(sessionId)` swaps in a fresh Tauri Channel,
  replays the scrollback, and re-emits status + the debug endpoint. Stdin keeps flowing through
  the original `docker run` pipe, so the terminal stays interactive. The inspect URL is held on
  the runner's session entry and re-emitted on re-attach (not stored in the editor index).

## Decisions

- **Runner owns history; editor stores an index only.** Re-fetch bodies from the runner rather
  than snapshotting logs into localStorage — avoids the ~5–10MB origin limit and keeps a single
  source of truth. Rejected: persisting full log/event snapshots client-side.
- **Reuse existing SSE/WS replay; no new runner endpoint.** Replay from offset 0 already
  delivers console + inspection history, so a dedicated snapshot endpoint would be redundant.
- **Best-effort durability via TTL extension (not durable storage).** Smallest change that makes
  reload work; accepts that history is lost on runner/pod restart and beyond the ring-buffer byte
  cap (long sessions may show `gap` markers). Rejected for now: persisting runner history to
  disk/volume — more infra than this iteration warrants.
- **Full restore on cold open, reattach interactive input only while running.** Cold opens
  always replay from offset 0; stdin is rewired only for sessions still in a running state.
- **Local docker resume is feasible because a reload is not a window close.** `kill_all_on_close`
  does not fire on reload, so the container lingers and can be re-attached; scoped as a separate
  phase because it needs new Rust plumbing rather than reusing an existing transport.

## Known limitations

- HTTP: history is lost on runner/pod restart and beyond the ring-buffer byte cap.
- Local docker: inspection-event *history* is best-effort (depends on the kernel inspect buffer);
  `--rm` means an exited container's logs vanish once it stops, so exited local sessions are
  resumable only while the container lingers.
