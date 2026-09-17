---
"@telorun/analyzer": minor
"@telorun/templating": minor
"@telorun/kernel": minor
---

A function's determinism is derived. A function written in CEL is deterministic and host-free exactly when everything it calls is — catalog functions and other module functions alike — and a native function is always host-backed and deterministic only where the kind supplying its controller declares `deterministic: true`. Every message about it names the chain to the leaf that decided it (`Billing.isStale → now()`). A module call's `CallSite` carries both flags, supplied through the new `AnalyzeEnv.moduleCallFlags`.

The consumers read the derived flags: `DURABLE_NONDETERMINISM` inside an `idempotent` region, the `CEL_NONDETERMINISTIC_IN_COMPILE_FIELD` warning, and rule conditions. A rule condition (`x-telo-resource-rules`, `x-telo-referrer-rules`) may now call a deterministic function written in CEL, which `telo check` evaluates; a call reaching a non-deterministic or host-backed leaf is refused naming the chain, and the refusal follows an edit to the body with no edit to the rule. A consumer's analysis now holds the private functions a library's exported functions call, so what those reach is derived rather than guessed.

A function satisfies a slot constrained to a callable abstract by `extends` or by its signature: results covariant, parameters contravariant, by position and by name — a holder calls it with the names the abstract declares — and, where the abstract requires it, determinism. A mismatch is `REFERENCE_KIND_MISMATCH` naming the parameter or the chain.
