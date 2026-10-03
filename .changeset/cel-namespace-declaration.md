---
"@telorun/cel": minor
---

A namespaced call is judged **only against what the host declared**, and a host may now declare less than
a whole signature. Two capabilities, each making a withholding structural rather than a flag:

**A namespace may be OPEN** — `registerNamespace(name, declarations, { open: true })`. A name it did not
declare then types `dyn`, is **listed as a call**, and is reported by nobody. A host whose name resolution
rests on vocabulary this engine may not learn — an export gate, a capability, a re-export chain — resolves
such a name itself and words that verdict itself. Closed stays the default, where an undeclared name is
`FUNCTION_UNRESOLVED` as before. Openness is per namespace, is inherited by a `clone()` and may be
withdrawn by re-registering, and it **enters the environment digest**: it decides whether an expression
checks clean, so two environments differing only in it must not share an emitted module.

**A declaration may WITHHOLD its parameter list** — `{ name, returns }` beside the existing
`{ signature }`. The call's result is typed and its arity and argument types are judged by nobody here, so
a host whose own signature grammar is richer than CEL's — an optional trailing parameter, a declared JSON
Schema per parameter — judges them itself and strictly better. The two forms are exclusive **by
construction**: there is no way to supply parameters and ask for them not to be judged, because that shape
would let a declaration carry a list nothing reads, which no reader can tell from a list that is simply
wrong. A withholding declaration still carries `deterministic`, `hostBacked` and `throws`, and is listed
as `total(…): double` rather than as a function of no arguments.

Both exist for one reason: judging a call against a declaration the host did not make leaves the host one
move — suppress the verdict — which is the after-the-fact classifier this engine exists to retire. The
engine declines the question instead of answering it wrongly and being overruled. `NamespaceListing` gains
`open`, so a consumer reading the definitions sees it.
