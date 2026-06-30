# `shell` Module — Command Execution

## Problem

A running Telo app cannot execute a command or spawn a process — `JavaScript.Script` is sandboxed and `Mcp.StdioClient` only spawns MCP servers. The authoring agent ([ai-authoring-agent-first-step](../../../apps/authoring-agent/plans/ai-authoring-agent-first-step.md)) needs to run `telo check`, `git`, and build/test commands; command execution is also a generic stdlib primitive (CI steps, migrations, codegen). This module provides it behind a **transport-neutral host abstraction**, so the same command runs locally today and over SSH / in a container later.

## Solution

One module, `std/shell` (`Telo.Library`, `modules/shell/telo.yaml`), controllers in `@telorun/shell` (`modules/shell/nodejs/`):

- `Shell.Host` — `Telo.Abstract`, `capability: Telo.Provider`: the execution target every driver implements. Operations reference it via `x-telo-ref: "std/shell#Host"`. The host `provide()`s the spawn primitive the operations call — exactly as `Sql.Connection` provides the DB handle its queries use.
- `Shell.Command` — `Telo.Invocable`. Runs a `command` string on a referenced `host` via `<shell> -c` (so pipes, `&&`, globs, and `cd` work); buffered result.
- `Shell.CommandStream` — `Telo.Invocable`, streaming `output` (`x-telo-stream`): a discriminated union of `{ type: "stdout" | "stderr", chunk }` records plus a terminal `{ type: "exit", exitCode, signal? }` / `{ type: "error", error }` — mirroring `Ai.TextStream`'s `text-delta` / `finish` parts. Drives live build/test/`telo run` output into the agent chat.
- `Shell.LocalHost` — `Telo.Provider`, `extends Self.Host`: the **bundled local driver**. Spawns via Node `child_process`; holds the execution environment — `cwd` (the directory commands start in — **not** a security boundary; see below), `shell` (interpreter — a PATH name or absolute path, default `/bin/sh` on POSIX / `ComSpec` on Windows), base `env`.

| Kind | Config | Invoke input | Result |
|---|---|---|---|
| `Shell.Command` | `{ host }` | `{ command, env?, stdin?, timeoutMs? }` | `{ stdout, stderr, exitCode }` |
| `Shell.CommandStream` | `{ host }` | same | `{ output: Stream<StreamPart> }` — `StreamPart` = `stdout` / `stderr` / `exit` / `error` records |

**Host↔Operation contract.** `Shell.Host.provide()` returns a single `run(command, { env?, stdin?, timeoutMs? })` primitive yielding a handle that supports both consumption modes — a buffered await (`→ { stdout, stderr, exitCode }`) and a record stream (`→ Stream<StreamPart>`). The host owns all composition: it does the `<shell> -c` wrapping (with its own interpreter), merges its base `env` with the per-call overlay, and runs in `cwd` — so the operations pass only `{ command, env overlay, stdin, timeout }` and never read host config. Ownership boundary: **Host owns {target, interpreter, base env, cwd}; Operation owns {command, env overlay, stdin, timeout}.** This one primitive is the entire transport-neutral seam — every remote driver (`shell-ssh`, Docker, k8s) implements exactly it, with the wrapping happening on the far side.

**Why local ships in core.** `child_process` is a Node builtin (zero marginal dependency) and local execution is the default every consumer needs — so unlike the `sql` family, where each driver is a heavy/native dependency that must stay out of core, there is no reason to push it into a separate `shell-local` module. Heavyweight remote drivers earn their own modules: `shell-ssh` (needs `ssh2`), Docker, and k8s, each importing core and `extends Shell.Host`.

`cwd` sets the directory commands start in — it is **not** a security boundary. A shell string can `cd` elsewhere, name absolute paths, or spawn children, so it cannot bound what runs; the effective trust boundary is *anything the host user can run*. Real isolation comes from where the host runs — the runner sandbox (container/pod) today, the `kernel/specs/module-grants.md` `sys.run` grant later (whose field shapes the driver tracks) — never from this field. Errors are surfaced, never swallowed: a non-zero exit is reported in `exitCode` (not thrown) so callers branch on it; spawn failures (missing binary, timeout) raise actionable errors.

The agent wraps `Shell.Command` — bound to a `Shell.LocalHost` with `cwd` at the seeded workspace — as its `run_shell` tool. Swapping the host for a future `ShellSsh.Host` moves the agent onto a remote box with no tool change.

## Decisions

- **Local driver bundled in core, remote drivers separate** — local execution is a zero-dependency Node builtin and the universal default, so it ships in `shell` as `Shell.LocalHost` (one import for the common case, self-contained core tests). `shell-ssh` / Docker / k8s carry real dependencies and stay separate, where the `sql`-style split actually pays. (Rejected: a separate `shell-local` module mirroring `sql-sqlite` — needless overhead for a builtin-only driver.)
- **Transport-neutral operations behind `Shell.Host`** — `Shell.Command` is written once; remote backends drop in via `extends Shell.Host`, the agent's tools unchanged.
- **`Host`, not `Connection`** — there is no link/handle to a local target; `Host` reads correctly for local and SSH alike. (`Target` rejected for lexical overlap with the Application `targets` field.)
- **Non-zero exit returned, not thrown** — a command that fails (e.g. `telo check` finding errors) is a normal result the agent must read, not an exception. Spawn/timeout failures still throw.
- **`Command` + `CommandStream` as separate kinds** — the buffered-vs-streaming split (the `Ai.Text` / `Ai.TextStream` precedent); streaming surfaces live output into the chat.
- **Streaming terminal data rides in the stream, not a sibling field** — the exit code isn't known until the process exits, so `Shell.CommandStream` emits it as a terminal `exit` record (and spawn/timeout as an `error` record), mirroring `Ai.TextStream`. The `type` discriminator lets `RecordStream.*` (`Tee` / `ExtractText` / routing) route and display the records, but there is **no** declarative path today to hoist `exitCode` out of the stream into a CEL-branchable scalar (no record→scalar reducer exists). So `Shell.CommandStream` is display-oriented; for pass/fail control flow use buffered `Shell.Command`, whose `{ stdout, stderr, exitCode }` are plain CEL values.
- **`command` is a shell string via the host's interpreter, default `/bin/sh`** — run as `<shell> -c <command>` so pipes/`&&`/globs/`cd` work; the interpreter is a host property defaulting to `/bin/sh` (POSIX) / `ComSpec` (Windows), not bash (absent on minimal images) nor `$SHELL` (a login-shell var). (Dropped an `args`/argv field — a direct-exec concept that conflicts with shell-string mode; a safe no-shell mode is deferred.)
- **`cwd` is ergonomics, not security; isolation is the sandbox** — `cwd` only sets where commands start; a shell string trivially escapes it (`cd`, absolute paths, child processes). Containment comes from the runner sandbox now and the `sys.run` grant later, never from this field — so the plan does not frame `cwd` as confinement.

## Example

```yaml
kind: Shell.LocalHost
metadata: { name: Workspace }
cwd: ./workspace
---
kind: Shell.Command
metadata: { name: RunCommand }
host: !ref Workspace
# invoked: inputs { command: "telo check ./telo.yaml" } → { stdout, stderr, exitCode }
```

## Build & housekeeping

- `modules/shell/telo.yaml` (`std/shell`) + `@telorun/shell` controllers (`modules/shell/nodejs/`) for `Shell.Command`, `Shell.CommandStream`, and the `Shell.LocalHost` provider; `Shell.Host` is abstract (no controller).
- Tests in `modules/shell/tests/*.yaml`: run command, capture stdout/exitCode, non-zero exit, timeout, and `cwd` default (a command's working dir is the configured `cwd`) — all against the in-module `Shell.LocalHost` (no cross-module test dependency). Fixtures under `__fixtures__/`. Run via `pnpm run test`.
- Docs in `modules/shell/docs/`, wired into `pages/docusaurus.config.ts` + `pages/sidebars.ts` with `sidebar_label`.
- Versioning: changie `Added` fragment (`changie new --project shell`); changeset for `@telorun/shell`; regenerate `.changie.yaml`.

## Out of scope

Remote driver modules (`shell-ssh`, Docker, k8s); a `RecordStream` collect-to-scalar reducer (would let one streamed run both display live output and yield a branchable `exitCode`); a persistent interactive shell session (stateful cwd/env across calls); `sys.run` grant enforcement; pty/tty allocation.
