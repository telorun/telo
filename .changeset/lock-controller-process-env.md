---
"@telorun/kernel": minor
"@telorun/config": patch
"@telorun/lambda": patch
"@telorun/mcp-client": patch
"@telorun/test": patch
---

Guard `process.env` against controllers bypassing declared bindings. Once the
kernel boots it replaces the global `process.env` with a guardrail Proxy whose
denied set is **derived from the manifest**: exactly the host env-var names the
root Application binds via `variables` / `secrets` / `ports` (their `env:` keys).
Such a key reads back `undefined` (and `'FOO' in process.env` / enumeration see
nothing) even when the variable is set, and the first read of each logs a
warning. Controllers must read those through `ctx.env` (the sanctioned snapshot
the kernel threads in) or, preferably, the declared `variables` / `secrets`.

Every **other** key passes through transparently (real value, no warning) — the
kernel carries no allowlist of vendor env conventions. A bundled SDK reading its
own configuration (`NODE_ENV`, `AWS_PROFILE` / `AWS_*` / `SMITHY_*`, `~/.aws`
path lookups, `BUN_*`, the AWS Lambda execution-environment context, …) is
undeclared, so it is untouched. The guarantee is narrow and honest: a controller
cannot bypass a *declared* binding by reading its raw env var. This is a
guardrail, not an isolation boundary — in-process controllers can still reach the
OS environment by other means; the `process.env` property is left non-writable so
a casual `process.env = {…}` cannot drop it.

The denied set is process-global and additive: several `Kernel` instances can
boot in one process (the test suite runs child kernels in-process), and each
unions its declared keys into the shared set even after the Proxy is installed.

The kernel's own `TELO_*` / cache reads and its subprocess spawns (`npm`,
`cargo`/`rustc`) use the real environment captured before the lock — shared on
`globalThis` so a second in-process `@telorun/kernel` copy (the test suite loads
its own to spawn child kernels) recovers it even when loaded after the lock,
rather than capturing the Proxy and handing child spawns an env missing the
denied keys. `analyzeOnly` loads never boot, so `telo check` / the editor / the
analyzer are unaffected.

The stdlib controllers that read host env use `ctx.env`: `config`
(`Config.EnvironmentVariableStore`), `lambda` (Lambda mode detection),
`mcp-client` (the spawned stdio child's environment), and `test` (the env the
suite forwards to each spawned test kernel). These keep their existing behaviour
and remain compatible with older kernels.
