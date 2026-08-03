---
"@telorun/kernel": patch
---

`ctx.runtime.check()` no longer analyzes a manifest that failed to parse, and no
longer drops the loader's version-reconciliation findings.

A file with a YAML syntax error still reaches the flattened manifest list as a
mangled `toJSON()` tree. Analyzing that produced diagnostics that existed only
because the parse failed — a stray key surfacing as `SCHEMA_VIOLATION`, for
instance — while the real `MANIFEST_PARSE_FAILED` never appeared at all, since
parse findings come from the loader and never reach `analyze()`. `check()` now
reports the parse findings and stops, the policy `load()` already applies by
treating a parse failure as fatal before analysis.

`versionDiagnostics` are merged in for the same reason: they are the loader's,
not `analyze()`'s, so without them a `MODULE_VERSION_CONFLICT` — which `load()`
refuses to boot on — checked completely clean.

Both are visible through `Assert.Manifest`, which reports whatever `check()`
returns.
