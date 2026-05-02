---
"@telorun/analyzer": patch
---

Recurse into nested step arrays via `x-telo-topology-role` annotations (`branch` / `branch-list` / `case-map`) when building the `steps.<name>.result` CEL context for kinds that opt into `x-telo-step-context`. Previously the analyzer hardcoded a fixed set of `Run.Sequence` field names (`then` / `else` / `do` / `catch` / `finally` / `try` / `default` / `cases`) and never descended into `elseif` branches at all — so step names defined inside `elseif` were invisible to later `${{ steps.X }}` references, producing spurious `CEL_UNKNOWN_FIELD` diagnostics. The recursion is now schema-driven: `elseif` is covered, and any future composer that tags its branch fields with the same roles works without analyzer changes.
