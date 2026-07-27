# @telorun/shell

## 0.3.0

### Minor Changes

- 942c176: Resolve provider-shaped `!ref` slots through `ctx.resolveRef` instead of a
  per-module copy of the same two-branch logic.

  The removed wrappers (`resolveCacheStore`, `resolveShellHost`,
  `resolveVectorStore`, `resolveEmbeddingModel`, `resolveJournal`) were one-line
  shims; call sites now pass the module's own type guard and the slot's `x-telo-ref`
  contract, so a mis-wire names the owning resource and what the slot wanted —
  `` Cache.Entry "page": 'store' … did not resolve to a resource satisfying
`std/cache#Store`  ``. Each module still
  exports its guard (`isCacheStore`, `isShellHost`, `isVectorStore`,
  `isEmbeddingModel`, `isJournalStore`, `isSqlConnection`) for consumers that
  resolve the slot themselves; `isJournalStore` is now duck-typed rather than
  `instanceof`, so it survives two copies of the package in one process.

  `resolveSqlConnection` stays — it encodes the optional-slot rule that lets a
  `Sql.Query` fall back to its `transaction` — and now takes a `describe` argument,
  so its six call sites report the owning resource instead of a bare `Sql:` prefix.
  Ref-typed manifest fields use the SDK's `KindRef<T>` rather than a hand-rolled
  `{ name, alias }`.

## 0.2.0

### Minor Changes

- 06c675b: `Shell.Command` / `Shell.CommandStream` gain an injection-safe **argv** form and env **unset**. Pass `args: [program, ...arguments]` (mutually exclusive with `command`) to exec a program directly with no shell, so an untrusted argument (a user- or agent-chosen path) can never be reinterpreted as shell syntax. A `null` value in `env` (per-call or a host's base `env:`) now **unsets** an inherited variable instead of setting it — the only way to keep a variable the parent holds (e.g. a secret) out of the spawned child. The `ShellHost.exec` seam now takes a `CommandSpec` (`{ command }` | `{ args }`) so every driver gets both forms.

## 0.1.0

### Minor Changes

- bc7d241: Add the shell module: run shell commands behind a transport-neutral `Shell.Host` abstraction — `Shell.Command` (buffered), `Shell.CommandStream` (streaming), and the bundled `Shell.LocalHost` driver.
