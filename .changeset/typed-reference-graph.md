---
"@telorun/analyzer": minor
"@telorun/ide-support": minor
"@telorun/templating": minor
"@telorun/kernel": minor
---

A reference slot now declares what the declaring resource does with its target,
and one shared graph answers "what calls what" for every analysis that needs it.

`x-telo-ref` gains a structured form — `{kind, use, inputs?}` — alongside the
bare string. `kind` takes one alias-qualified kind or a list of them, replacing
the `anyOf` wrapping that multi-kind slots used; a schema branch per acceptable
kind would let `use` disagree with itself, and which kinds are acceptable is a
property of the target while `use` is a fact about the slot. `use` names when
control reaches the target relative to the declaring resource's own invocation:
`schema` (no instance exists), `dependency` (held and read), `call`, `detached`,
`trigger.inbound`, `trigger.consumer`. It is a set, because one slot can
dispatch its target more than one way in a single invocation — `Cache.View`
calls inline on a miss and detached on a background revalidation — and a slot
whose mode is chosen by configuration declares a map keyed on a sibling field
(`Lease.Critical` is `call` or `detached` by its `detach:` value), whose
selector must be statically resolvable.

A new `Telo.Executable` built-in abstract is the parent of `Telo.Invocable` and
`Telo.Runnable` — "control can be transferred to this" — collapsing every slot
that spelled `Invocable | Runnable`. It is a slot constraint, never a lifecycle
role, so `capability: Telo.Executable` remains invalid; and it never
cross-constrains `use`, because `Ai.Model` declares `Telo.Provider` while
exposing entry points by convention, so a nominal rule would reject a correct
`use: call`. `Telo.Service` stays outside it: a service's `run()` is a lifecycle
start the kernel dispatches without an ambient scope, and admitting it would
make every step's `invoke:` accept a service.

`buildCallGraph` builds one typed graph over two node kinds. Resource nodes
carry declaration-site identity; step nodes carry name, lexical order, enclosing
array and nesting parent, and only optionally an edge — a pure `value:` step
produces a result while referencing nothing, so a graph of reference edges alone
could not see it. Edges are `(from, slot, to, use)` and the graph is a
multigraph: the slot path is part of an edge's identity, so `Cache.View` holding
its `store:` as a dependency and calling its `invoke:` are two distinct edges
even when both name the same resource. The init-order consumer projects down to
unique pairs itself, since it is the only one for which that distinction does
not matter.

The dependency graph, run-reachability, and the step-invoke check now read that
graph instead of building private walkers. Two unsound inferences go with them:
run-reachability had been two independent over-approximations that had to agree
by coincidence, and the step-invoke check maintained a set of capabilities it
believed could never be invoked — a set listing `Telo.Provider`, which rejected
the shipped `Ai.Model` wiring. Capability now decides what a resource can do; it
no longer decides whether a slot transfers control.

One accessor reads the annotation for every surface — the analyzer, the kernel's
Phase-5 injection, the GUI editor's reference picker, and `ide-support`'s
completions, hover and go-to-definition — because making the annotation
structured changes how a slot is *recognised*, and four surfaces recognised it
by string-matching. That fixes two pre-existing divergences: hover never peeled
`anyOf` branches, so a multi-kind slot showed no reference at all, and
completion stopped at the first branch, offering only an `Invocable | Runnable`
slot's invocables.

The annotation's own validity is enforced (`validate-ref-slots.ts`): an
unrecognized `use` token, a structured annotation missing `kind` or `use`,
`anyOf` branches whose uses disagree, and a case-map selector written in CEL
are diagnostics — a typo would otherwise silently degrade a slot to the legacy
unannotated reading, and a call graph known only at runtime is not statically
analyzable. A case-map selector that is omitted takes its schema `default:`,
so the common spelling (`Lease.Critical` with no `detach:`) resolves statically.

The graph also discovers refs by value-tree scan (a `!ref` in a structure no
annotation anticipated is an edge, read conservatively) and descends
`x-telo-scope` arrays (a `with:`-scoped resource is a node whose own slots are
walked, scope-local names resolving first). Init order keys on whether a site
is a Phase-5 injection site — never on node kind — so an Application's inline
`targets[].invoke` and gated `{ref, when}` entries order boot exactly as
before.

`@telorun/templating`'s `normalizeRefSlots` recognises the structured
annotation (a presence test instead of `typeof === "string"`), so a structured
slot's stale scalar `type` is dropped the same way a bare-string slot's is.

The kernel rejects `capability: Telo.Executable` on a definition — it is an
`x-telo-ref` slot constraint (the parent Telo.Invocable and Telo.Runnable
extend), not a lifecycle role — with a named error at `create()` instead of an
anonymous `oneOf` failure; the analyzer reports the same mistake statically as
`CAPABILITY_NOT_DECLARABLE`.
