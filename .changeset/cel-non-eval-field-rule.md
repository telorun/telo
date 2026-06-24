---
"@telorun/analyzer": minor
"@telorun/kernel": patch
---

Add a `CEL_IN_NON_EVAL_FIELD` analyzer diagnostic: a `!cel` (or `${{ }}`) in a field the runtime never evaluates — one with no `x-telo-eval` and outside every `x-telo-context` / `x-telo-step-context` / `x-telo-error-context` region — is now an error instead of passing silently. This closes the static gap that let a `!cel` `concurrency` on `Run.Projection`/`Run.Iteration` read as a literal and degrade to `[null, …]` at runtime. The check resolves eval-paths from both the resource's own schema and its capability abstract (so provider fields, all implicitly `x-telo-eval`, stay live) and stops at nested inline `{ kind }` resource boundaries (their CEL is governed by their own kind).

`x-telo-eval` path handling now lives in `@telorun/analyzer` and is re-imported by the kernel, so the runtime and the analyzer share it rather than re-implementing it. Both halves are shared: `buildEvalPaths` (schema → eval paths) and the containment rule `evalPathCovers` (does an eval path cover a concrete path). The analyzer's coverage check (`evalPathsCover`) and the kernel's compile/runtime exclusion (`isExcluded`) both route through `evalPathCovers`, so a change to the matching semantics applies to both at once. The kernel's `expandPaths` keeps its own tree-walk for expansion (it mutates the value tree, not a coverage test), structurally consistent with the shared rule because eval paths are property-only.
