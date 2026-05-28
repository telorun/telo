# Run Sessions & History

## Problem

The editor models runs as a single global `activeRun` in
[run/context.tsx](apps/telo-editor/src/run/context.tsx). Two consequences:

1. **Blank-screen crash.** `RunIo.open()` is single-shot — it throws on a
   second call ([docker-api/io-client.ts:34](apps/telo-editor/src/run/adapters/docker-api/io-client.ts#L34),
   [tauri-docker/io-client.ts:64](apps/telo-editor/src/run/adapters/tauri-docker/io-client.ts#L64)) —
   and [TerminalView.tsx:65](apps/telo-editor/src/run/ui/TerminalView.tsx#L65)
   calls it from a mount effect. `startRun` flips the run view open *before*
   awaiting the new session, so after a run ends and the view was closed,
   clicking Run re-mounts `TerminalView` against the still-present,
   already-opened previous `io` → `open()` throws → React tears down the tree.
2. **One run at a time, no history.** Only the current run exists; switching
   apps or starting a new run discards the previous one entirely.

## Solution

Replace the single `activeRun` with a **per-application run store** in the run
context, and decouple terminal rendering from the single-shot transport.

**Per-app store.** Keyed by the Application's module `filePath` (the editor's
existing app identity). Each app owns an ordered list of run records plus a
pointer to its live run. A run record carries id, adapter id/display name,
status, start/end timestamps, exit info, and its output buffer. Multiple apps
hold live runs concurrently; each keeps its own session subscription. The list
is capped at 10 per app (oldest evicted); the whole store is in-memory for the
editor session.

**Output buffer** (new unit under `apps/telo-editor/src/run/`). One buffer per
run. It owns the single `io.open()` call for that run, records the byte
transcript (or log lines for log-only adapters), fans out to whatever view is
currently attached, and exposes a snapshot for replay. While the run is live it
passes keystrokes/resize through to the live `RunIoConnection`; once terminal it
is replay-only. Transcript is capped (~2 MB, oldest-byte eviction, reusing the
pre-open buffer pattern already in the tauri io-client).

**TerminalView attaches to the buffer**, not to `io`. On mount it replays the
snapshot into a fresh xterm, then streams live updates; input is enabled only
for the live run. This both fixes the double-open crash (the buffer, not the
view, owns the one `open()`) and makes any past run re-viewable.

**Start/stop.** `startRun` resolves the target app, stops that app's current
live run if any (the stopped run stays in history), creates the session and its
buffer (opening `io` once, immediately), appends the record, and marks it live +
selected. The eager-open-against-stale-`io` window is gone.

**Selected run.** Run-context state names which run's output `RunView` shows.
`RunView` ([run/ui/RunView.tsx](apps/telo-editor/src/run/ui/RunView.tsx)) stays
the full-canvas output viewer, now reading the selected run's record/buffer.

**TopBar split button.** The Run button in
[TopBar.tsx](apps/telo-editor/src/components/TopBar.tsx) becomes a split control:
the main button runs the active Application; a chevron opens a `DropdownMenu`
([ui/dropdown-menu.tsx](apps/telo-editor/src/components/ui/dropdown-menu.tsx))
listing that app's recent runs with a status chip and start time. Selecting one
opens `RunView` for that run. The button's status reflects the active app's
live (or most recent) run.

**Read-model seam.** The UI consumes run history through one interface — "the
run list for this app, and each run's output." It is served from the in-memory
store today; a runner-backed history client can satisfy the same interface
later without the UI changing.

## Non-goals

- No persistence layer — history is in-memory for the editor session only. No
  localStorage, no storage driver.
- No runner-owned history in this work (the eventual authoritative home; see
  Decisions). No reattaching to live sessions after an editor reload.
- No change to the adapter `RunSession` / `RunIo` contracts — the buffer wraps
  the existing single-shot `io`.

## Decisions

- **In-memory only; no storage driver.** Rejected a localStorage cache
  (authority-less, can't recover transcripts, and would be replaced wholesale
  later) and a "swappable DB/API driver" (browsers can't reach a database, and a
  client-authoritative storage API is an unsafe dumb sink).
- **The runner is the eventual authority for run history; the editor is a
  reader.** It already owns the real run facts (status, exit codes, output).
  That keeps the durable seam at the UI read model, not at a storage driver.
  Deferred because it spans both backends (HTTP runner + tauri/Rust) and needs
  an app-identity at session creation that the runner has no concept of today.
- **Output buffer owns the single `io.open()`; the view attaches to the
  buffer.** Rejected keeping `TerminalView` as the opener — it is the root cause
  of the crash and makes history un-replayable.
- **Runs keyed by Application `filePath`.** That is the editor's existing app
  identity; app grouping is a client fact because the runner has no app concept.
- **Same-app re-run stops the current live run and keeps it in history.**
  Rejected refusing until stopped — worse UX, and history wants the prior run
  regardless.
- **Caps: 10 runs/app, ~2 MB/transcript with oldest-byte eviction.** Bounds
  memory across concurrently-running apps.
- **Run list lives in the Run-button chevron dropdown.** Chosen over a left
  rail, bottom dock, or sidebar section.
- **`RunView` stays full-canvas, driven by a selected-run id** rather than a
  single global active run.
