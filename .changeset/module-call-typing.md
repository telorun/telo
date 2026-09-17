---
"@telorun/analyzer": minor
"@telorun/templating": minor
"@telorun/kernel": minor
---

`telo check` judges a module call against what it reaches, as the kernel does when it binds it. `FUNCTION_UNRESOLVED` now means a name no resource answers to — through `Self` or the module's own name among the module's own resources (never a `with:` scope's), through an alias among what the imported library declares — and says why. A private one is `FUNCTION_NOT_EXPORTED`, a resource that is not a function `FUNCTION_NOT_CALLABLE`, a count the parameter list does not accept `FUNCTION_ARITY_MISMATCH`, and an argument whose CEL type — or, for an argument naming a value, whose declared shape — does not fit its parameter `FUNCTION_ARGUMENT_MISMATCH`. All are entry-module-scoped.

A call types as the callee's declared `returns`, so an operator over it is checked and a member read off it is checked against the result's schema (`CEL_UNKNOWN_FIELD`). A `Telo.Function` body must produce its declared result (`FUNCTION_RETURN_MISMATCH`, read through the new `x-telo-returns-from` annotation); its parameters see through named shapes at any depth, and a nullable parameter, or an optional one with no default, must be guarded (`CEL_NULLABLE_ACCESS`). A template body's calls resolve through the module that defines the kind. A function is absent from the `resources` scope, since it publishes no reading. A module call in an import's `variables:` is reported once, at the import.

A module call where the runtime binds no function is refused where it is written: `FUNCTION_CALL_UNBOUND`, declared by the new `x-telo-unbound-calls` annotation on an Application's `logging:` block (resolved while the application loads) and on a `Telo.JsonSchema` rule's `condition` (evaluated against the value alone).

A module call is a dependency edge in the call graph, so boot creates a callee before its caller, and a function calling itself, directly or through another, is `DEPENDENCY_CYCLE` in `telo check` and `ERR_CIRCULAR_DEPENDENCY` at boot, where it used to defer until the init loop gave up. The module graph does not draw these edges.

In the kernel, a wrong argument count is a structured `ERR_FUNCTION_ARITY_MISMATCH` a `try:` step can catch, and a durable suspension raised inside a function reaches its workflow unwrapped rather than as `ERR_FUNCTION_FAILED`. Each argument and the result of a module call are normalized to the scalars the signature declares, exact conversions only, so an int passed where a parameter declares `type: number` reaches the body as the double it was typed against. A call to a function an import re-exports resolves through the export table, as it runs.
