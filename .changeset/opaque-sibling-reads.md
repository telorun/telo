---
"@telorun/sdk": minor
"@telorun/kernel": minor
---

Resolving a sibling by name is now recorded, so a host reconciling a changed
manifest can tell when it must not narrow.

A declared `x-telo-ref` slot is the only thing that puts an edge in the manifest,
and that edge is what orders teardown and what says which resources become
invalid when one is rebuilt. `ctx.moduleContext.getInstance(name)` has neither:
nothing says the caller is holding what it got. A reconciler built on the edges
alone would rebuild such a target and leave the holder pointing at a dead
instance.

`getInstance` therefore records the name it resolved while the module is still
initializing — the window in which a caller can keep what it gets. A resolution
taken afterwards is not recorded, because it re-resolves on the next dispatch and
there is nothing to invalidate. That discriminator is the one the method already
turned on to tell a dependency deferral from a genuine not-found, so it costs
nothing new.

`ModuleContext.resolveDeclaredInstance(name)` is the same lookup without the
recording, for a name that came out of a declared slot already — a `!ref` that
reached a controller as a raw sentinel rather than being injected. `resolveRef`
uses it, so a declared reference is never recorded. The polarity is deliberate:
the method a module author reaches for is the one that records, and only code
that already knows its edge is declared opts out.

`EvaluationContext.impactedBy` returns the closure together with the names it
cannot cover, rather than absorbing them. A closure reaching a by-name resolution
is not an answer, so those names are reported and the caller escalates naming
them; expanding the set to "every resource here" would sweep in the module
document, which is not a resource anything can unwind and re-register, and would
present a whole-context rebuild as a narrowing.

The standard library needs no changes. Only `Config.Variables` and
`Config.Secrets` resolve a store by name, and `config` is deprecated in favour of
declaring variables and secrets on the application directly; the escalation
covers them exactly, at the cost of a context-wide rebuild for an app still using
them.
