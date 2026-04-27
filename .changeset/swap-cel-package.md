---
"@telorun/analyzer": patch
"@telorun/kernel": patch
"@telorun/yaml-cel-templating": patch
"@telorun/type": patch
---

Switch CEL implementation from `@marcbachmann/cel-js` (tree-walking interpreter) to
`@marvec/cel-vm` (bytecode VM). Runtime hot paths now compile each `${{ }}` expression
once via `env.compile()` / `program()` and cache the resulting bytecode/closure for
subsequent evaluations.

Tradeoffs on this branch:

1. cel-vm exposes only opaque bytecode — no public AST and no `env.check()` for
   return-type inference. The analyzer's AST-dependent passes are disabled accordingly:

   - `extractAccessChains` returns no chains, disabling `CEL_UNKNOWN_FIELD` diagnostics
     on context fields.
   - Throws-coverage proof from `when:` clauses (`error.code == 'X'` flattening) returns
     `proven: false`, so coverage proofs by `when:` no longer count.
   - Per-expression CEL return-type vs JSON-schema type checking is skipped; only
     syntax / arity / undeclared-function errors are still surfaced via `env.compile()`.

2. cel-vm's `[key]` indexing requires real `Map` instances — plain JavaScript objects
   only support `.field` (`SELECT`) access. Activation values are passed through to
   cel-vm unchanged (no Map wrapping), to preserve the bytecode VM's performance
   advantage. Modules whose CEL expressions use dynamic indexing on object-typed
   variables (e.g. `inputs.data[k]` in `modules/sql-repository`) currently fail at
   evaluation with `cannot index unknown` and need to be rewritten to use `.field`
   access or a different pattern.
