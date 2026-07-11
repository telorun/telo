---
"@telorun/templating": patch
---

Align CEL aggregate-literal type-checking with cel-go: disable
`homogeneousAggregateLiterals` so heterogeneous list/map literals unify to `dyn`
instead of erroring. Previously a map literal whose value type was inferred as
`dyn` (the common manifest case — `result.rows`, `request`, …) still rejected a
differently-typed entry (e.g. `{'id': r.id, 'done': r.done == 1}` →
`Map value uses wrong type, expected 'dyn' but found 'bool'`) even though the
runtime evaluates it fine. This was a static-vs-runtime false positive; cel-go
defaults this check off for exactly this reason.
