---
"@telorun/kernel": minor
"@telorun/sdk": minor
"@telorun/analyzer": minor
---

Execution zones — a resource can declare that it must be reached through
another resource's body (a transaction, a durable run, a batch), checked
statically and enforced at dispatch. Normative contract in
`kernel/specs/execution-zones.md`.

**SDK.** `ZoneEntry` and `InvokeContext.zones` (the ambient zone stack, ordered
outermost first); `deriveContext(base, overrides)`, the one way to build a
context from another — a fresh object literal at a rebuild site drops every
field it does not restate, which for `zones` would mean the stack surviving with
tracing off and vanishing under `--debug`. `ResourceInstanceId` /
`ResourceHandle` / `sameResource`: a kernel-minted per-instance identity that is
a compared string rather than an object reference, so an entry crosses the ABI
and no controller can read another module's instance off the stack. New
`ResourceContext` members: `self`, `withZone(slot, fn)`, `requireZone(field)`,
`findZone(field)`, `zonesFor(instance)`, `rootContext(opts?)`.

**Kernel.** The handle is minted at `create()`, the single instance-production
site, so an instance is never observable unbound; the instance → handle map has
no reverse direction. `withZone` derives every field of the entry from the
slot's `x-telo-provides-zone` annotation (resolved in the kind's *declaring*
scope) — a controller names its own annotation site, never a kind, because it
has no alias scope of its own. Clearing is the default state rather than a list
of sites: `runDetached` already replaces the ambient context and a
`Telo.Service`'s `run()` establishes none, so the only residue is a
`trigger.inbound` registered from inside an invocation by a non-Service, which
`rootContext()` names as a conformance obligation. `Http.Api`, `Mcp` tools and
`Schedule.Cron` / `Interval` dispatch through it.

**Analyzer.** `resolve-zone-requirements.ts`, a consumer of the call-graph
service with no traversal of its own: requirements propagate along `call` edges,
discharge at providing slots under the correlation rule (`extends`-aware), and
fire at edges the runtime guarantees are cleared. `zone-slot.ts` is the single
reader of both annotations, the `ref-slot.ts` precedent. Per-library export
derivation runs as its own stage in `analyze()` over each library's full
documents, cached in a host-lifetime cache the caller owns, keyed
`(source identity, content signature)`. `validate-zone-slots.ts` is the strict half of the same accessor split
`validate-ref-slots.ts` has, and is not optional: the two annotations fail in
opposite directions (an unreadable requirement is silently unenforced, an
unreadable provision invents failures), and a correlation key written as a bare
field name would be read by the kernel's pointer walk but skipped by the
checker — the two halves disagreeing about what a manifest means. New
diagnostics: `ZONE_REQUIREMENT_UNSATISFIED` (error),
`ZONE_REQUIREMENT_DEFERRED` (warning), `ZONE_EXPORT_UNSATISFIABLE` (error, at
the exporting library only), `ZONE_PROVIDER_UNRESOLVED` (error),
`ZONE_ANNOTATION_INVALID` (error).

`ResourceContext.invoke`'s fourth parameter is now a typed
`InvokeByNameOptions` bag (`{ ctx?, retry? }`) rather than `any`. It always
carried `retry`; `ctx` joins it so an inbound registrant can seed the
invocation context, which a positional parameter could not do safely —
`ResourceContext` satisfies `InvokeStepContext` structurally, so a positional
context would silently receive a step's retry options.

Also fixes a latent bug in `buildCallGraph`: it resolved a resource's definition
by raw kind, but a manifest carries the kind as authored (`Run.Sequence`) while
the registry is keyed canonically (`run.Sequence`). Every alias-form kind — that
is, every kind in a real manifest — missed silently, so step collection found no
step list and a step's declared `use` never reached its edge, and a case map's
selector found no schema `default`. Definitions now resolve in the scope of the
module that declared the resource, matching `expandedFieldMapForResource`.
