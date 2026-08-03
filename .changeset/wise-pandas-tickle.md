---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/sdk": minor
---

Named CEL bindings: a kind can declare a `bindings:` map whose names are in scope inside its own expressions.

A kind opts in with `x-telo-bindings-from: "<field>"` on the `x-telo-context` node of every field that sees the names — the same annotation family as `x-telo-context-from` / `x-telo-context-element-from`, so no kind is named in analyzer code. `analyzer/nodejs/src/cel-bindings.ts` (exported as `resolveBindingOrder` / `findBindingSites` / `bindingContextProperties` / `bindingPathChain` / `schemaAtChain`) derives each binding's dependencies from the **root of every member-access chain its expression parses to** — never from a token scan, which would read `inputs.total` as depending on a sibling binding named `total` and reject a correct manifest — merges the names into the CEL context so they type-check, and reports `BINDING_CYCLE`, `BINDING_NAME_RESERVED` (any name `buildCelEnvironment` already binds at that site, kernel globals included, plus CEL's keywords, which can never be read as a reference) and `BINDING_FIELD_AMBIGUOUS` (a kind whose contexts point the annotation at two different fields).

The kernel adds `ctx.bindScope(bindings, scope)` (`ControllerContext` / `EvaluationContext`), which extends a scope with accessor properties evaluated lazily and memoised per returned scope, so a binding nothing reads is never evaluated and one read repeatedly is computed once. `expandWith` merges such a scope by property descriptor rather than by value — copying the values would force every getter at merge time — so the returned scope must reach `expandValue` by identity. A name already in scope is skipped, the caller's own and the **ambient globals on the context** alike, which bounds a reserved name the static check did not foresee to a dead binding rather than a hijacked global. A binding that reaches itself raises `ERR_BINDING_CYCLE`.

`x-telo-step-context` accepts an optional `value` field naming the step key that produces a result without dispatching. Such a step registers `steps.<name>.result` typed from its expression when that expression is a plain chain into something already typed (an earlier step's result, the kind's `inputType`), and permissively otherwise.
