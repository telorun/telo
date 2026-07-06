# @telorun/shell

## 0.2.0

### Minor Changes

- 06c675b: `Shell.Command` / `Shell.CommandStream` gain an injection-safe **argv** form and env **unset**. Pass `args: [program, ...arguments]` (mutually exclusive with `command`) to exec a program directly with no shell, so an untrusted argument (a user- or agent-chosen path) can never be reinterpreted as shell syntax. A `null` value in `env` (per-call or a host's base `env:`) now **unsets** an inherited variable instead of setting it — the only way to keep a variable the parent holds (e.g. a secret) out of the spawned child. The `ShellHost.exec` seam now takes a `CommandSpec` (`{ command }` | `{ args }`) so every driver gets both forms.

## 0.1.0

### Minor Changes

- bc7d241: Add the shell module: run shell commands behind a transport-neutral `Shell.Host` abstraction — `Shell.Command` (buffered), `Shell.CommandStream` (streaming), and the bundled `Shell.LocalHost` driver.
