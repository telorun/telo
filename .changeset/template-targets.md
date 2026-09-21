---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/templating": patch
"@telorun/sdk": patch
---

Templated kinds can start several entries with `targets:`

A templated `Telo.Service` / `Telo.Runnable` definition may list `targets:` — `!ref`s to its `resources:` entries, started in order when an instance runs — instead of a single `run:`, so a kind can start a server beside the poller that feeds it. `telo check` reports `TEMPLATE_TARGETS_INVALID`, `TEMPLATE_TARGET_UNKNOWN`, `TEMPLATE_TARGETS_CAPABILITY` and `TEMPLATE_TARGETS_WITH_RUN`; the kernel refuses the same definitions at registration as `ERR_<code>`.

Two template fixes ship with it: `self` now reads the schema's `default:` values, at every depth, wherever the instance leaves a field out; and an expression calling a non-deterministic function (`uuidv4()`, `nowMillis()`) or any module function (`Self.fn()`) is no longer evaluated once for the whole instance — the compiled value carries a new `volatile` flag for the former.
