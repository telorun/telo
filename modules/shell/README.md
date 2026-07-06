# @telorun/shell

`std/shell` — run shell commands behind a transport-neutral host abstraction.
The same command runs on the local host today and over SSH / in a container
later (drivers ship as their own modules and extend `Shell.Host`, mirroring the
`sql` / `sql-sqlite` family).

## Kinds

- **`Shell.Host`** — abstract execution target (`Telo.Provider`). A driver's
  instance exposes the spawn primitive the operations call. The host owns
  command composition (`<shell> -c <command>`, env merge, cwd), so the
  operations are backend-agnostic.
- **`Shell.Command`** — run a program on a `host`; buffered
  `{ stdout, stderr, exitCode }`. A non-zero exit is **returned, not thrown** —
  branch on `result.exitCode`. Spawn failures and timeouts throw. Give it
  **either** a `command` string (run through the shell, `<shell> -c <command>`)
  **or** an `args` array (execed directly, `args[0]` is the program) — see
  [Argv](#argv-execution-injection-safe).
- **`Shell.CommandStream`** — same, streaming `{ type: stdout|stderr, chunk }`
  records then a terminal `{ type: exit, exitCode, signal }` / `{ type: error,
  error }` on `result.output`. Display-oriented; for control flow use
  `Shell.Command`.
- **`Shell.LocalHost`** — bundled local driver (`extends Shell.Host`), runs via
  Node `child_process`.

## Confinement

`cwd` on a host sets the directory commands start in — it is **not** a security
boundary. A shell string can `cd` elsewhere, use absolute paths, or spawn
children, so it cannot bound what runs. Real isolation comes from where the host
runs (the runner sandbox), not this field.

## Argv execution (injection-safe)

`command` runs through the shell, so shell metacharacters in an interpolated
value are interpreted — a value like `x.yaml; rm -rf ~` is command injection.
When any part of the invocation is untrusted (a user- or agent-chosen path),
use `args` instead: it execs `args[0]` directly with the rest as arguments and
**no shell**, so an argument is never reinterpreted as syntax.

```yaml
kind: Shell.Command
metadata: { name: Check }
host: !ref Local
# invoked with inputs { args: ["telo", "check", untrustedPath] }
# → the path is one literal argument; `; rm -rf ~` cannot inject.
```

`command` and `args` are mutually exclusive — provide exactly one.

## Environment

A command's environment is the host environment (`PATH`, `HOME`, …) overlaid
with the host's base `env:` and then the per-call `env` input — later wins. The
host env is read through the kernel-sanctioned `ctx.env`, so commands see the
same variables the app was launched with; pass `env:` to add or override.

A `null` env value **unsets** an inherited variable rather than setting it — the
only way to keep a variable (e.g. a secret the parent holds) *out* of the child:

```yaml
kind: Shell.Command
metadata: { name: Keyless }
host: !ref Local
# invoked with inputs { args: [...], env: { OPENAI_API_KEY: null } }
# → the child cannot read OPENAI_API_KEY even though the parent has it.
```

## Example

```yaml
imports:
  Shell: std/shell@0.1.0

kind: Shell.LocalHost
metadata: { name: Local }
cwd: ./workspace
env:
  CI: "true"
---
kind: Shell.Command
metadata: { name: Check }
host: !ref Local
# invoked with inputs { command: "telo check ./telo.yaml" }
# → { stdout, stderr, exitCode }
```
