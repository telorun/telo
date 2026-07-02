# AI Manifest-Authoring Agent — First Step

## Problem

The telo editor (`apps/telo-editor`) has no AI assistance; manifests are authored entirely by hand. We want a first vertical slice of an AI agent that authors manifests on the user's behalf — working directly on the workspace filesystem and streaming its edits back into the editor. It must work in the browser across all runners (the agent runs remotely), with the editor as a thin client.

## Solution

The agent is its **own Telo application** in `apps/authoring-agent` — a long-lived `keepAlive` service the editor runs on a runner exactly like any other bundle, and runnable locally too. Dogfooding: the manifest-authoring assistant is itself a telo manifest, composing `Ai.AgentStream` (`modules/ai`, the streaming tool-use agent — see `modules/ai/plans/agent-stream.md`; OpenAI via `modules/ai-openai`), `Http.Server` (`modules/http-server`), `Run.Sequence` + SQLite for conversation state, and new native tool modules.

New native stdlib modules give the agent its hands:

- `modules/fs` — `Fs.FileReader` / `Fs.FileWriter` / `Fs.DirectoryLister` / `Fs.FileRemover` invocables, path-confined to a configured workspace root.
- `modules/shell` — a `Shell.Host` abstract (`Telo.Provider`: the execution target) plus the transport-neutral `Shell.Command` (buffered `{ stdout, stderr, exitCode }`) and `Shell.CommandStream` (streaming stdout/stderr, `x-telo-stream`) invocables, and the bundled `Shell.LocalHost` driver (`extends Self.Host`, runs via local `child_process`, sets the working directory `cwd` — not a security boundary). Local execution is a zero-dependency Node builtin so it ships in core; heavyweight remote drivers (SSH/Docker/k8s) slot in later as their own modules, mirroring `sql` / `sql-sqlite`.

All are wrapped via `Ai.Tools` into the agent's `toolProviders`. Their field shapes align with the future grant spec (`kernel/specs/module-grants.md` `fs.*` / `sys.run`); enforcement is deferred. The agent validates its own output by running `telo check` through the shell tool — no separate analyzer tool. Its system prompt states which shell it runs on (default `/bin/sh`; `sh` ≠ bash).

The agent exposes its own HTTP API on a declared port (ingress-fronted by the runner — **no runner-core changes**). Flow:

1. Editor runs the agent app on a runner; the runner advertises the agent's port URL via the existing `RunStatus.running` endpoints.
2. Editor seeds the user's workspace by POSTing the workspace files to the agent (`POST /workspace`); the agent writes them under its workspace directory. The `RunBundle` carries only the agent program; the user's files travel separately.
3. Editor POSTs a chat message; the agent runs its `Ai.AgentStream` turn (history persisted in SQLite via `Run.Sequence`), editing files through the fs/shell tools.
4. The agent streams the assistant response **and** one file-mutation event per write back over a single SSE stream (monotonic sequence IDs).
5. The editor applies each mutation idempotently (content-hash keyed), reloads the affected `ModuleDocument`, re-runs analysis, and persists through its existing `WorkspaceAdapter` — local disk / FSA / localStorage stays the durable home; the agent's remote FS is ephemeral working state.

The editor side mirrors the existing run-adapter machinery: a new `AgentAdapter` seam (parallel to `RunAdapter` in `src/run/types.ts`), an `AgentContext` (parallel to `RunProvider` in `src/run/context.tsx`), a manual/AI mode flag on `EditorState` (`src/model.ts`), and a dockable chat **side panel** (parallel to the run terminal, available across all views). SSE consumption reuses the patterns in `src/run/adapters/http-runner/`.

Sync is **single-writer-per-mode**: in AI mode the agent owns the workspace and the editor reflects; manual edits are disabled. The SSE mutation stream carries the happy path with replay-on-reconnect + gap detection (the `packages/runner-core` ring-buffer pattern); a full workspace **tree-hash reconciliation** is the backstop that also catches files written via bash rather than the fs tool.

## Decisions

- **Agent is its own app, not a sidecar** — authoring needs the workspace, not the user's running app, and keeps the agent a normal runnable bundle. (Rejected: sidecar to the running app — only needed for live-app interaction, a later capability.)
- **Published port + keepAlive service, not a runner contract change** — the runner's I/O WebSocket is PTY-only and its event union is closed; a declared port exposing the agent's own HTTP/SSE API sidesteps both with zero runner-core work, and a never-terminal session never triggers TTL eviction.
- **Native `fs`/`shell` modules, not MCP-compose** — generic stdlib primitives, reusable beyond the agent, type-safe at the manifest level, aligned with the grant spec. (Rejected: bundling external MCP servers — faster but external deps and weaker typing.)
- **`shell` operations are transport-neutral behind a `Shell.Host` abstract; the local driver ships in core, remote drivers are separate modules** — command tools are written once against `Shell.Host`, and `shell-ssh` (and later Docker/k8s execution) drop in via `extends Shell.Host`. Local execution is a zero-dependency Node builtin, so unlike the `sql` family (heavy, plural, native drivers) it lives in core as `Shell.LocalHost` rather than a `shell-local` module — one import for the common case, self-contained core tests. `Host` over `Connection` because there is no link to a local target. (Rejected: a separate `shell-local` module mirroring `sql-sqlite` — needless overhead for a builtin-only driver. fs stays flat for now — its remote case (SFTP/S3) overlaps the existing `s3` module, so an `Fs.FileSystem` abstraction is deferred until reconciled.)
- **OpenAI only** — `ai-openai` ships today; no Anthropic provider in this slice.
- **SSE transport, not WebSocket** — `http-server` speaks HTTP and the editor already has resilient SSE replay; reused rather than rebuilt.
- **Workspace seeded separately from the agent bundle** — clean separation between the agent program and the files it edits.
- **SQLite + `Run.Sequence` conversation state** — `Ai.AgentStream` is stateless; reuses the proven agent-console multi-turn pattern and yields replay for free.
- **Single-writer-per-mode sync + tree-hash backstop** — eliminates the merge-conflict class; hash reconciliation guarantees convergence after any disconnect and catches bash-written files.
- **`fs` is path-confined, `shell` is not; isolation is the runner sandbox** — `Fs.*` resolve paths against a `root` the controller enforces (a real boundary for fs-only consumers); `Shell.*`'s `cwd` only sets a starting directory and an arbitrary shell string escapes it. Once an unconfined shell is in the toolset the agent's effective trust boundary is *anything the host user can run*, so containment comes from where the agent runs (the runner sandbox) plus the `kernel/specs/module-grants.md` grants later — not from tool-level paths.

## Out of scope (this slice)

Full dirty-state/undo reconciliation (AI edits are treated as external reloads from a clean entry state; undo integration deferred); manual↔AI switching nuances; multi-runner hardening (targets local/one runner); grant enforcement; Anthropic provider; remote shell drivers (`shell-ssh`, Docker/k8s) and an `fs` filesystem abstraction — both deferred behind the established core/driver pattern.

## User-facing flow after the change

A user opens a workspace and toggles the editor into **AI mode**; a chat side panel appears. They type a request ("add an HTTP health endpoint"). The editor spins up `authoring-agent` on a runner, seeds the workspace, and forwards the message. The agent edits files; within moments the changed manifests update live in the editor's graph and source views while the assistant's reply streams into the chat panel. Switching back to manual mode returns file ownership to the user.

## Build order & housekeeping

1. `modules/fs` + `modules/shell` (with the bundled `Shell.LocalHost`) — controllers, `telo.yaml` definitions, tests under `modules/<name>/tests`, docs in `modules/<name>/docs` wired into `pages/docusaurus.config.ts` + `pages/sidebars.ts`, changie fragments per module.
2. `apps/authoring-agent` — the agent manifest composing `ai` / `ai-openai` / `http-server` / `run` / `sql` + the new tools.
3. Editor — `AgentAdapter` + `AgentContext` + mode flag + chat side panel + SSE mutation handling + tree-hash reconciliation; changeset for every touched `@telorun/*` package.
