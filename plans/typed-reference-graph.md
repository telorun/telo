# Typed reference graph

**Prerequisite to `plans/execution-zones.md`**, which it simplifies: the `x-telo-dispatch`
annotation, its unclassified advisory and its CI gate all disappear into this.

## Status

**Landed.** The shared accessor (`analyzer/nodejs/src/ref-slot.ts`) with the analyzer,
editor, `ide-support` and kernel field-map all reading slots through it; the structured
annotation accepted alongside the string form; `Telo.Executable`; all 116 standard-library
slots and the analyzer builtins migrated to declare their `use`; the graph service
(`analyzer/nodejs/src/call-graph.ts`) with resource and step nodes, value-tree discovery
(a `!ref` in a structure no annotation anticipated is a conservative edge) and
`x-telo-scope` descent (scoped declarations are nodes whose own slots are walked,
scope-local names first); case-map selectors resolved against schema defaults, with the
unresolvable reasons distinguished (`dynamic` / `absent` / `unmatched`); the annotation's
own validity enforced (`validate-ref-slots.ts` — invalid or missing `use`, missing
`kind`, branch disagreement, CEL selector); and three consumers
moved onto it — `buildDependencyGraph`, `collectRunReachableNames`, and the step-invoke
executability check, whose executable side is derived from the `Telo.Executable` `extends`
hierarchy (`NON_INVOKABLE_CAPABILITIES` deleted; only the kernel-owned no-entry-point
capabilities remain named, as their own contract). Init order keys on whether a site is a
Phase-5 injection site — never on node kind — so an Application's inline
`targets[].invoke` and gated `{ref, when}` entries order boot as they always did.

**Remaining.** The other six consumers (`resolve-throws-union`, `validate-throws-coverage`,
`checkRefSlotWiring` with `slotTakesPairedInputs` / `isRunOnlySlot`, the three
`walkStepArray` callers, and the editor's overview graph + step collector); retiring the
redundant edge vocabularies (`x-telo-topology-role: invoke | inputs | steps`,
`x-telo-catches-for`, `x-telo-step-context`'s `invoke` key); removing the bare-string form
and making `use` mandatory; and correcting `kernel/docs/topology.md`.

**Decoupled from this plan:** lifting the `$ref` non-descent in `reference-field-map.ts`.
The graph reads step slots from the step item schema during its own walk, so it needs
nothing from the field map — and leaving the non-descent in place keeps the kernel's
Phase-5 injection surface exactly where it is, which is the risky half. The remaining
reason to lift it is `ensureKindRef`'s rescue branch, not the graph.

## Problem

A `!ref` is one untyped edge. Manifests express at least four unrelated relationships
through it — construct-and-hold, transfer control now, register to be called later, and
name a schema — and nothing distinguishes them. `x-telo-ref: Self.Model` (dispatched by
the agent controller) is indistinguishable from `x-telo-ref: Sql.Connection` (never
dispatched). Across the standard library 133 ref slots (plus 7 in the analyzer's
builtins) carry no statement of what the declaring controller does with the target.

Every analysis that needs call structure therefore rebuilds it privately. There are
**nine** such models today and only two share code: the `walkStepArray` trio, the throws
union, the boot dependency graph, run-reachability, the invocation-contract wiring rule,
throws coverage, the editor's step collector, the editor's overview graph, and the
kernel's runtime spans. They disagree. `resolve-throws-union` dispatches on hardcoded
step key names while the schema builder it claims to mirror is role-driven, so a composer
that renames a branch is walked by one and silently dropped by the other. The same edge is
already annotated twice under unrelated vocabularies — `routes[].handler` carries
`x-telo-topology-role: handler` while its sibling `catches` field names it back via
`x-telo-catches-for: handler`, and neither pass knows about the other. There are six
implementations of "recurse into nested step arrays" and five of "navigate a field-map
path through a value".

The gap is also encoded as *inference*, unsoundly: `NON_INVOKABLE_CAPABILITIES` treats
capability as dispatchability and lists `Telo.Provider` as never-invokable while `Ai.Model`
is a Provider the agent controller invokes directly. `isRunOnlySlot` and
`slotTakesPairedInputs` guess a call site from a constraint's capability and from a
sibling field. Capability names a lifecycle role; it has never named a call relationship.

## Solution

**A reference slot declares what the declaring resource does with the target, and cannot
omit it.** `x-telo-ref` becomes structured — a constraint plus a mandatory `use` — so the
unclassified state is unrepresentable rather than defaulted and chased with a gate. The
bare string form is removed. This is the whole point: a slot that has not answered is not
a slot.

`kind` accepts one alias-qualified kind **or a list of them**, replacing the `anyOf`
wrapping that 20 slots use today. The list is
not sugar: `anyOf` puts each `x-telo-ref` in its own branch, so a structured form under it
could carry a *different* `use` per branch — a disagreement with no meaning, since which
entry point the controller calls is a property of the target's capability while `use` is a
property of the slot. One slot, one `use`, several acceptable kinds. The analyzer already
unions those branches into a single list internally, so this makes the surface match the
model that was always underneath.

**A new capability, `Telo.Executable`, is the parent of `Telo.Invocable` and
`Telo.Runnable`** — "control can be transferred to this" — and it collapses the dominant
multi-kind slot outright: the seventeen that spell `Invocable | Runnable` become
`Telo.Executable`. It costs two inheritance edges. It is the first abstract-extends-abstract
edge in the builtins (the nearest precedent today is `Telo.LogSink` carrying
`capability: Telo.Sink`), but nothing structurally blocks it: kind acceptance is already a
transitive walk over the `extendedBy` index. `Telo.Executable` names no lifecycle role, so
it is a slot constraint only — `capability: Telo.Executable` on a definition is rejected.

It also replaces `NON_INVOKABLE_CAPABILITIES` with a positive statement: a slot that
accepts any executable says so, instead of the analyzer maintaining a set of capabilities
it believes can never be invoked.

**`use` is not cross-constrained against the target's capability.** The tempting rule —
a control-transferring `use` requires an `Executable` constraint — is unsound, and
`Ai.Model` is the counterexample: it declares `capability: Telo.Provider` and no schema at
all, exposing `invoke` / `stream` as an ai-module convention. Its slot is genuinely
`use: call`, so the rule would reject a correct declaration. The divergence is structural
versus nominal: the kernel tests method presence at dispatch, while any static test can
only read declared capability, and those coincide for every kind that declares
`Invocable`/`Runnable` and part company exactly where entry points are conventional. So
`Telo.Executable` is a *constraint authors put on slots*, never a gate the analyzer infers
onto `use` — capability keeps saying nothing about whether a slot transfers control, which
is this plan's whole premise. Closing the gap honestly means making a kind's entry points
declarable, which is a separate change and a real prerequisite to any such rule.

`Telo.Service` stays deliberately outside `Executable`: its `run()` is a lifecycle start
that the kernel already dispatches differently (no ambient scope, so inbound work roots
its own trace), and a step's `invoke:` must keep rejecting it. Slots accepting
`Runnable | Service` — boot targets — therefore remain lists, which is the honest shape
for a genuinely heterogeneous set.

`use` names **when control reaches the target relative to the declaring resource's own
invocation**, the one primitive fact every consumer derives from:

- **`schema`** — no runtime instance exists (`Telo.Type` slots). No edge of any kind.
- **`dependency`** — held and read; control never transfers. Init-order edge only.
- **`call`** — control transfers during my invocation and returns to me.
- **`detached`** — control transfers during my invocation through the kernel's detach
  primitive; I do not await it.
- **`trigger.inbound`** — I register the target; control reaches it after my invocation,
  driven by a request or a timer, and the runtime guarantees a fresh ambient context.
- **`trigger.consumer`** — I register the target; control reaches it when someone drains a
  value I returned, so no guarantee holds either way.

The trigger source lives **inside the value**, not in a sibling key. A `trigger` with no
source is precisely the unclassified state this plan exists to abolish — the zone consumer
needs guaranteed-cleared and unknowable to be different answers, and neither is a safe
default — and a separate key can be omitted, cannot appear in a `use` case map, and would
need its own diagnostic to police. One dotted enum makes the omission unrepresentable and
drops into a case map unchanged. Consumers that care only about the relation match the
`trigger.` prefix.

Each consumer reads one fact and derives its own: exceptions propagate across `call`
alone; an ambient zone's lifetime extends across `call` alone, is guaranteed cleared
across `detached` and `trigger.inbound`, and is unknowable across `trigger.consumer`;
a resource is run-reachable if any control-transferring edge reaches it; the
dependency graph orders on everything but `schema`; the editor draws edges for control
transfers and inline pickers for `dependency`.

**`use` is a set, written as one value when it is a singleton.** A slot may dispatch its
target more than one way within a single invocation, and `Cache.View` is the case that
forces this: with `revalidate: background` a stale hit refreshes **detached** while a miss
on the very same slot calls **inline**, so no single value is true. It declares
`use: [call, detached]`. Every consumer already reduces a set — exceptions propagate if
**any** member is `call`, an ambient zone's lifetime extends only if **every** member is —
so this is a reduction each consumer states rather than a shape the model has to avoid.
The list is not the `anyOf` mistake in another spelling: those branches disagreed about
*which kinds are acceptable*, which is a property of the target, while these agree that the
slot does several things, which is a fact about the slot.

**A slot whose mode is chosen by configuration declares `use` as a map keyed by that
sibling field** (`Lease.Critical` is `call` or `detached` by its `detach:` value, genuinely
exclusive — the body runs inline or detached, never both). This is the one conditional
form, and it exists because "these are really two kinds" is a module-design judgement the
syntax cannot make on behalf of third parties. A case's value is a `use` or a list of them,
the same set as everywhere else. **A field that selects a `use` must be statically
resolvable** — a literal or a schema default — and a CEL value there is a diagnostic. There
is deliberately no fallback: no single value is conservative for every consumer, since the
throws union must assume `call` to keep an error path and a zone requirement must assume the
opposite to avoid inventing one, so any default would reintroduce exactly the unsound
inference this plan deletes. A call graph that is only known at runtime is not statically
analyzable, which is the property the whole design exists to protect.

A case map and a set answer different questions and do not substitute for each other:
the map says *the configuration decides which relation holds*, the set says *several hold
at once*. `Cache.View` needs the set rather than a map keyed on `/revalidate` precisely
because `background` does not select detached — it **adds** it.

**Pointers inside `x-telo-ref` are relative to the object enclosing the annotated slot.**
For a resource-level slot that is the resource root; for a slot inside an array item it is
the item, so a route's `handler` can name its siblings. One rule covers both, and no
pointer can reach across an array boundary — if a case for root anchoring ever appears it
gets its own spelling, the split `x-telo-context-from` and `x-telo-context-from-root`
already make.

**One call-graph service, not a tenth model.** `analyzer/nodejs/src/call-graph.ts` builds
a single typed graph over **two node kinds**. Resource nodes carry their resolved
declaration-site identity; **step nodes** carry name, order, enclosing array and nesting
parent, and *optionally* an outgoing edge. Steps are nodes rather than edge decorations
because a pure `value:` step produces `steps.<name>.result` while referencing nothing —
it has no edge to hang on — and because step identity, ordering and nesting are what
`steps.<name>.result` typing, per-step throws coverage and the editor's step rendering
actually consume. A graph of resource edges alone could not replace those three, and the
"one model" claim would be false.

**A step's position is manifest data, never schema data.** No definition declares a next
or previous step, and none needs to: order is the written order of the array, and the walk
is a manifest × schema co-traversal, so the array is in hand exactly where step nodes are
minted. The schema's whole contribution is to mark an array as a step list and to name the
fields that nest further steps. What the model therefore carries is **lexical order and
containment, not execution order** — which branch actually runs is decided by runtime
predicates and is not statically derivable. That is sufficient by construction: result
typing needs step names, throws coverage needs `try` / `catch` containment rather than
which arm fires, and the editor renders rows as written.

Edges are `(from, slot path, to, use)`, where `from` is a resource or a step node. **The
slot path is part of the edge's identity, so the graph is a multigraph**: a kind declaring
several ref slots emits one edge per slot, each with its own `use` — `Cache.View` holds
its `store:` as a `dependency` while its `invoke:` is a `call` — and two slots may name the
same target without collapsing, because `use` is a property of the slot and never of the
resource. Array slots emit one edge per element, indexed. This is a requirement, not a
detail: today's `dependency-graph.ts` keeps a set-valued adjacency map, which erases
parallel edges and would silently merge a dependency with a call. The init-order consumer
projects the multigraph down to unique pairs itself, since that is the only consumer for
which the distinction genuinely does not matter. Slot identity is also what lets a
diagnostic name *which* of a kind's refs is at fault.

The walk is value-tree-driven the way
`resolve-ref-sentinels.ts` already is (a `!ref` is an explicit marker, so it is found
everywhere), consults schemas for classification, follows local `$ref` into `$defs`, and
descends `x-telo-scope` arrays. It owns the only step-array recursion and the only
field-path navigator in the analyzer.

The `$ref` non-descent in `reference-field-map.ts` **stays**. The graph reaches a step's
ref slots through the step item schema during its own walk, so it needs nothing from the
field map — and the field map's descent is what decides Phase-5 injection sites, which is
the half with real blast radius. Lifting it buys only `ensureKindRef`'s raw-sentinel rescue
branch, and costs making every step's `invoke:` an injection site; that trade is its own
change. Note the blocker comment there is stale either way: injected instances now route
through `ctx.invokeResolved` via the `REF_IDENTITY` stamp. A second bypass would have to be
closed with it — `resource-template-controller.ts` still calls `entry.instance.invoke()` /
`.run()` directly — and what goes from `ensureKindRef` is only the rescue branch, since the
method also registers inline definitions and has seven controller call sites plus an SDK
interface member.

**Every surface that reads a ref slot goes through one accessor.** Making the annotation
structured changes how a slot is *recognised*, not just how it is analyzed: the editor's
schema form gates its reference picker on `x-telo-ref` being a string (directly and inside
`anyOf` branches), and `packages/ide-support` resolves completions, hover and
go-to-definition the same way. Left out, this change would silently turn every ref slot in
the GUI editor into a free-text field and kill reference completions — a direct hit on the
visual-editing goal. So the analyzer exposes a single browser-safe accessor returning a
slot's constraint set and `use`, and the editor form, `ide-support`, the editor's graph
builders and the kernel's Phase-5 injection all call it. No consumer pattern-matches the
annotation's shape again — which is what makes the next shape change a one-file edit. The
kernel re-imports it rather than carrying its own reader, the pattern already set by the
invocation-contract resolver and the eval-path matcher.

**Consumers migrate onto the graph** and delete their private walkers: the dependency
graph, the three `walkStepArray` passes, `resolve-throws-union`, `validate-throws-coverage`,
`collectRunReachableNames`, `checkRefSlotWiring`, and the editor's overview graph and step
collector.
The three inference sites go, each replaced rather than merely dropped:
`NON_INVOKABLE_CAPABILITIES` becomes the `Telo.Executable` test, `slotTakesPairedInputs`
becomes the `call` edge's own declared argument slot, and `isRunOnlySlot` — which asked
whether a slot can only be `run()` — resolves the **wired target's** capability instead of
guessing from the slot's constraint list, which is the only sound reading once a slot may
say `Executable`. Capability keeps deciding what a resource *can* do and which entry point
receives control; it stops deciding whether a given slot transfers control, which is what
it was never able to answer. `Ai.Model` remains a `Telo.Provider`, and its slot declares
`use: call`.

**Redundant edge vocabularies collapse into the edge and the step model.** A `call` edge
names its own argument slot and its own caught-outcome slot, retiring
`x-telo-topology-role: invoke | inputs` and `x-telo-catches-for`. `x-telo-step-context`
loses its `invoke` key for the same reason — the slot's `use: call` already says it — and
keeps only what remains genuinely step-model: which field carries a pure step's value and
which carries a per-step output type. That annotation is also what marks an array as a step
list, so `x-telo-topology-role: steps` retires as its duplicate; `branch`, `branch-list`
and `case-map` stay, now describing step-node nesting in the one step model rather than
being loose recursion hints. What is left of `x-telo-topology-role` is purely
presentational — `predicate`, `discriminator`, `matcher`, `entries`, `handler`, which the
editor uses to render route tables and step rows and no analysis reads. (`steps` is already
editor-only today; no analyzer pass reads it.) And `kernel/docs/topology.md` is corrected,
since it describes a kernel execution engine that does not exist — it is banner-marked a
proposal, so the correction is to retire the parts this plan supersedes rather than to
contradict a claim of shipped behaviour.

**Sequencing, and the parity gate.** The change spans four surfaces and deletes nine
walkers, so it lands by consumer rather than all at once — and never annotation-first,
which would leave a vocabulary nothing reads. The order keeps a working tree throughout:
the shared accessor lands first and every surface starts reading slots through it; the
structured `x-telo-ref` is then *accepted alongside* the string form and stdlib's slots
declare their `use`; the graph service is built on that input; the nine consumers move
onto it one at a time; and the string form is removed last, at which point making `use`
mandatory is a pure schema change because nothing reads the old shape. **A walker is
deleted only once the graph reproduces its diagnostic set on that pass's existing
fixtures** — the migration's correctness is a parity property, and it is the half of this
work where a silent regression is actually likely.

Runtime spans stay as they are. The runtime tree is deliberately severed at every
`Telo.Service` boundary, and reconciling it with the static graph needs a declared notion
of trigger *sources at runtime* that this plan does not introduce.

## Decisions

- **`use` is mandatory, with no default and no bare-string form** — the zones plan needed
  opaque-default plus a CI gate only because it could not force annotation onto published
  third-party schemas. With back-compatibility not a constraint, the illegal state is made
  unrepresentable instead. Rejected: a sibling annotation with an opaque default (silence);
  barrier-style default (fatal, unfixable in someone else's artifact); a CI gate (a policy
  substituting for a type).
- **`kind` takes a list; multi-kind slots stop going through `anyOf`** — a schema branch
  per acceptable kind lets `use` disagree with itself, and the accepted-kind set is a
  constraint on the target while `use` is a fact about the slot. Which entry point the
  controller calls follows from the target's capability and needs no separate declaration.
  Rejected: keeping `anyOf` (an illegal state becomes expressible); a `use` per branch
  (nothing it could mean).
- **`Telo.Executable` is an author-declared slot constraint, never a gate on `use`** — it
  collapses the seventeen `Invocable | Runnable` slots and replaces
  `NON_INVOKABLE_CAPABILITIES` with a positive declaration. It does **not** cross-constrain
  `use`: `Ai.Model` declares `Telo.Provider` and no schema while exposing entry points by
  convention, so a nominal rule would reject a correct `use: call`. `Telo.Service` is
  excluded because its `run()` is a lifecycle start the kernel dispatches differently, and
  admitting it would make step `invoke:` slots accept services. Rejected: requiring an
  executable constraint for control-transferring uses (contradicts the plan's own premise
  and its headline example); an exception list for convention-based kinds (the unsound
  inference this plan deletes); claiming the static and runtime tests become one (they
  cannot until entry points are declarable — a separate change).
- **One axis: when control arrives, relative to my invocation** — every consumer derives
  its own semantics from that single fact, which is what stops the next cross-cutting
  concern from adding a family. Rejected: separate relation and timing axes (free to
  disagree); per-concern annotations (the status quo, nine models).
- **`trigger` carries a `source` qualifier** — `inbound` and `consumer` differ in whether
  the runtime *guarantees* a fresh context, and collapsing them makes a stream handler's
  requirement a hard error on a manifest that works. Rejected: one `trigger` value (false
  errors); promoting `source` to the main axis (it refines exactly one relation).
- **Mode-dependent slots declare a value map, and the selector must be static** — the
  alternative to a map, splitting each mode into its own kind, is a module-design decision
  the syntax must not mandate; and a CEL selector is refused outright because no fallback
  is conservative for every consumer (throws needs `call`, a zone requirement needs the
  opposite), so any default reintroduces unsound inference. Rejected: a predicate DSL;
  JSON Schema `if/then`; a "weakest use" fallback; an `unresolved` state each consumer
  interprets its own way (four consumers, four chances to disagree about one slot).
- **`use` is a set; a case map and a set are different questions** — `Cache.View` dispatches
  one slot both inline (miss) and detached (background revalidation) under a single
  configuration, so a map keyed on `revalidate` would be a lie: `background` adds the
  detached dispatch rather than selecting it. Each consumer states its own reduction over
  the set (`call` if any, zone-extends only if all), which it was doing implicitly anyway.
  Rejected: forcing `Cache.View` to split into two kinds (the module-design mandate the
  case map exists to avoid); declaring the strongest single member (silently drops the
  other dispatch, the unsound inference this plan deletes).
- **Steps are nodes, not edge decorations** — a pure `value:` step produces a result while
  referencing nothing, so a ref-edge-only graph cannot see it, and step identity, order and
  nesting are exactly what the three step-scoped consumers read. Modelling them is what
  lets `x-telo-topology-role: steps` retire without orphaning `branch` / `case-map`.
  Rejected: a resource-edge-only graph with the step model left standing beside it (the
  "one model" premise fails, and the two would drift as they do today).
- **One accessor for the annotation's shape, shared with the editor, IDE and kernel** —
  the change alters how a ref slot is *recognised*, and the two surfaces that recognise it
  by string-matching are the GUI form and the IDE support package. Omitting them would
  break visual editing, a core goal, at implementation time rather than in review.
  Rejected: migrating analyzer passes only; each surface reading the new shape itself.
- **Pointers are relative to the enclosing object** — one rule serves a resource-level
  sibling and an array item's sibling, and nothing can address across an array boundary.
  Rejected: root anchoring (cannot reach a route's siblings); one syntax silently meaning
  both (the ambiguity `x-telo-context-from` / `-from-root` was split to avoid).
- **The trigger source is part of the `use` value** — a sibling key can be omitted, has no
  place in a `use` case map, and would need a diagnostic to enforce what an enum enforces
  structurally. Rejected: `source:` beside `use:`; case-map values becoming objects so a
  second key fits (two shapes for one fact).
- **The graph is a service, not just an annotation, and it lands by consumer** — a
  vocabulary without a shared consumer becomes model number ten, so the consumers are
  committed scope; but the *order* is accessor → dual-accepted annotation → graph →
  consumers one at a time → old form removed, each walker retired only against a
  diagnostic-parity check on its own fixtures. Rejected: shipping the annotation as the
  deliverable and migrating later; one atomic landing across four surfaces with no
  intermediate working state and no parity property.
- **Capability decides executability and entry point, never whether a slot is a call** —
  the two shipped inference sites are already wrong about `Ai.Model`, a Provider the agent
  controller invokes. Splitting the question this way is what lets `Telo.Executable` be
  load-bearing while `use` stays the sole authority on control transfer.
- **Runtime spans are out of scope** — the runtime graph is cut at service boundaries by
  design; unifying it is a separate concern with its own trade-offs.

## Complete example after the change

Every `use` value, each on the standard-library slot that genuinely carries it — no slot
had to be invented, which is itself evidence the vocabulary is complete for what ships:

```yaml
# ── schema ─── modules/run/telo.yaml — names a shape; no runtime instance, no edge
outputType:
  x-telo-ref:
    kind: Telo.Type
    use: schema
---
# ── dependency ─── modules/sql/telo.yaml — held and read; control never transfers
connection:
  x-telo-ref:
    kind: Self.Connection
    use: dependency
---
# ── call ─── modules/ai/telo.yaml — a Provider-capability target that is nonetheless
# called. Nothing cross-checks `use` against the constraint's capability.
model:
  x-telo-ref:
    kind: Self.Model
    use: call
---
# ── call, with its argument sibling ─── modules/run/telo.yaml — the pointer is
# relative to the step item, not the resource root.
# `Executable` is one capability, not an `anyOf` of Invocable and Runnable.
invoke:
  x-telo-ref:
    kind: Telo.Executable
    use: call
    inputs: /inputs
---
# ── detached ─── modules/run/telo.yaml (Run.Detach) — dispatched through the kernel's
# detach primitive during my invocation, never awaited. The kind stays
# Telo.Invocable: the controller only dispatches invoke(), and widening the
# accepted set is a controller change, not an annotation change.
invoke:
  x-telo-ref:
    kind: Telo.Invocable
    use: detached
---
# ── trigger.inbound ─── modules/http-server/telo.yaml — registered now, driven later
# by an inbound request; the runtime guarantees a fresh ambient context
handler:
  x-telo-ref:
    kind: Telo.Executable
    use: trigger.inbound
---
# ── trigger.inbound ─── modules/scheduler/telo.yaml (Schedule.Cron) — the same value
# for a timer: `inbound` means "driven by the runtime from outside any invocation",
# not "HTTP". An outbound HTTP request needs no source of its own — from the caller's
# side it is simply a `call` on the client resource.
invoke:
  x-telo-ref:
    kind: Telo.Executable
    use: trigger.inbound
---
# ── trigger.consumer ─── modules/record-stream/telo.yaml (OnComplete) — the handler
# fires when whoever holds the returned stream drains it; no guarantee either way
handler:
  x-telo-ref:
    kind: Telo.Executable
    use: trigger.consumer
---
# ── conditional ─── modules/lease/telo.yaml — mode chosen by a sibling config field,
# which must be statically resolvable. Genuinely exclusive: the body runs inline or
# detached, never both.
invoke:
  x-telo-ref:
    kind: Telo.Executable
    use:
      by: /detach
      cases: { false: call, true: detached }
---
# ── set ─── modules/cache/telo.yaml (Cache.View) — one slot, two dispatches under one
# configuration: a miss calls through inline, a stale hit refreshes detached. Not a case
# map — `revalidate: background` adds the detached dispatch rather than selecting it.
invoke:
  x-telo-ref:
    kind: Telo.Invocable
    use: [call, detached]
---
# ── kind list ─── analyzer/nodejs/src/builtins.ts (Application targets) — a genuinely
# heterogeneous set stays a list
targets:
  x-telo-ref:
    kind: [Telo.Runnable, Telo.Service]
    use: call
```

An author writes no annotation at all — wiring manifests are unchanged. What changes is
that `telo check` can now answer, for any slot, whether control reaches the target and
when, and every analysis reads that one answer.
