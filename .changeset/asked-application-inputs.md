---
"@telorun/kernel": minor
"@telorun/cli": minor
"@telorun/analyzer": minor
"@telorun/runner-core": minor
"@telorun/docker-runner": minor
"@telorun/k8s-runner": minor
"@telorun/debug-wire": patch
---

`telo run` at a terminal asks for the application inputs nothing supplies instead of failing. When the only reason a root Application cannot load is that `variables:` / `secrets:` / `ports:` entries or the required fields of its needs have no value, the CLI asks for each one on stderr (a secret or sensitive need field without echo), the kernel decodes and validates each answer exactly as it would the same text in the environment, re-asks one it refuses with its own sentence, and the run starts. Answers are the fifth and last source — after a value supplied by name, the command line, `env:` and `default:` — and are never written to the process environment, `ctx.env` or a started child's environment; a need field's answer goes only into that need. Once accepted, the CLI offers to save them (default no): secrets to the sensitive env file, everything else to the other, as `telo env template --write` places them. A watch session keeps its answers across reloads.

It asks only when stdin and stderr are both terminals and `--no-input` (a new `telo run` option) is not given. Without that, the refusal is unchanged (`ERR_MANIFEST_VALIDATION_FAILED`, `ERR_NEED_UNMET`, `ERR_NEED_PARTIALLY_SUPPLIED`) and adds a hint naming the missing variables; `Kernel.RunFailed` carries them as `unresolved`. The kernel's `load()` takes the asking side as an `inputResolver` option. Every runner backend now starts applications with `--no-input`, and the oldest telo a runner supervises moves to the release carrying it.
