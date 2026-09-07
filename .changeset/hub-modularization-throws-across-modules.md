---
"@telorun/analyzer": minor
"@telorun/cli": patch
---

Two defects a library's exported entry point exposed, and the diagnostic that
was missing behind one of them.

A `resources:` entry is constrained by kind alone, so its kind-only stand-in
routinely IS an abstract — and identity did not satisfy an abstract slot, so
every use of that name inside the library was reported as a kind mismatch
against the very kind the author wrote. Identity now satisfies it for that
stand-in and for nothing else: a resource genuinely declared `kind: <some
abstract>` is refused by the kernel at `create()`, and is now reported as
`ABSTRACT_KIND_INSTANTIATED` at its declaration, carrying the same "instantiate
a concrete implementation: …" hint the kernel's own refusal does.

And the throws walk stopped at a `!ref` still carrying its parse-time sentinel,
reading "cannot see it" as "throws nothing": a consumer's flat set holds a
library's exported instances and not the siblings they invoke, so an entry point
that raises its own code through an internal guard presented an empty union and
had the consumer's `catches:` rejected for the code it documents. Such a name is
library-internal, so it resolves in the declaring library's own documents first —
asking the consumer's flat set first let any resource that happened to share the
name supply an unrelated union. An alias-qualified source resolves through the
declaring module's alias table; ambiguity, and a target in neither set, are
unbounded rather than empty.

The tag's grammar now has one reader (`refSentinelTarget`). Three passes had
grown their own parse and disagreed about what `!ref Alias.name` names; each
keeps its own reduction over the shared parse.

`ZoneModuleDocuments` is renamed `ModuleDocuments`: the zone stage's
per-library export derivation was its first consumer and the throws walk is
its second, so a third should not have to import "zone" to ask about
something else again. The CLI's patch is that call site and nothing more.
