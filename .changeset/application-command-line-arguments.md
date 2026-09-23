---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/sdk": minor
"@telorun/cli": minor
"@telorun/k8s-runner": patch
---

Added: a root Application reads its command line through declared bindings. A `variables:` or `ports:` entry may carry `arg:` beside `env:` — a flag name, `{ flag, short? }`, or `{ position }` — and needs one of the two. Precedence is a value supplied by name, then the command line, then the environment, then `default:`. A repeated flag fills an array-typed entry, each token read by `items.type`; a boolean is `--x` / `--no-x`; `--` ends options. An argument nothing declares, a missing flag value, a surplus positional or a value failing its type is refused before boot in `ERR_MANIFEST_VALIDATION_FAILED`, naming what the application declares, and `--help` prints the usage the bindings describe instead of running — a synopsis (`[<name>] [--tag|-t <string>]... [--[no-]verbose]`) then one line per argument; the analyzer exports the same rendering (`renderArgumentSynopsis`, `renderApplicationUsage`) for other hosts. `telo check` reports a conflicting or malformed binding as `ARG_BINDING_INVALID`, a secret bound to the command line as `ARG_BINDING_ON_SECRET`, and `arg:` in a library as `LIBRARY_ARG_KEY_REJECTED`.

Changed: every argument after the manifest path now belongs to the application — `telo run [options] <path> [application arguments]`, as `node [options] app.js [args]` — so `telo run app.yaml --watch` becomes `telo run --watch app.yaml`. Before the path, `--inspect` reads a following `[host:]port`; a bare host is written `--inspect=<host>`. Controllers no longer receive the command line: `ctx.args`, `ParsedArgs` and a controller's `args` export are removed from the SDK (the kernel still hands an already-published controller an empty `args`).
