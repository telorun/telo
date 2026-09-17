---
"@telorun/templating": minor
"@telorun/analyzer": minor
"@telorun/sdk": minor
---

CEL resolves a call whose receiver is one of the declaring module's names — its `imports:` keys, `Self`, its `metadata.name` and `Telo` — into a late-bound module call, carrying the qualified name as written. A bare name is still always the core catalog, so `format(…)` and `Billing.format(…)` never collide, and `a.b.c(x)` is an ordinary method call. Resolution happens on the parsed tree at compile, so diagnostic ranges and the expression a trace shows stay the author's; a partial compiles with the names of the module including it, and the loader's parse cache is keyed on them.

Every CEL analysis reads the resolved tree rather than re-parsing: access chains, a compiled value's `refs`, binding dependency order, module-graph data edges, scope-reach and the unused-declaration walk never take a module name for a root identifier; `CEL_UNKNOWN_FUNCTION` / `CEL_WRONG_CALL_FORM` skip a module call, and no catalog determinism or host-backed flag is attached to one. `CompiledValue` gains `calls`, the expression's qualified calls, beside `refs`. The analyzer registers a module's own `metadata.name` as an alias beside `Self`, which the kernel already did.

Evaluating a module call that nothing bound fails with `unbound function '<qualified>'`. A rule condition calling one is refused at the declaring kind, since a rule is evaluated where no module's functions are bound.

`BINDING_NAME_RESERVED` extends to a comprehension variable or `cel.bind` name equal to one of the module's names, and to an `x-telo-bindings-from` key equal to one. An import alias a kind already puts in CEL scope is `IMPORT_ALIAS_SHADOWS_CONTEXT`, reported at that `imports:` key. `CEL_UNKNOWN_IDENTIFIER` on a call receiver says a module call needs an `imports:` alias, where the name could denote a module at all.
