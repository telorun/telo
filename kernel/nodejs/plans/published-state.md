# Plan — Declared observed state (`status:`)

## Problem

A resource has no way to report something it learns while running, and no way to declare what it
reports.

`resources.<name>` is fed from one place: whatever `instance.snapshot()` returned, captured after
`init()` (`kernel/nodejs/src/evaluation-context.ts`) and refreshed after each invoke
(`kernel/nodejs/src/module-context.ts`). Nothing declares that shape, so the analyzer registers
`resources` as a bare `map` (`analyzer/nodejs/src/cel-environment.ts`) and every field access passes,
typos included. There is nowhere to record that a value exists only once the application is running,
so a field that resolves at startup — every `Telo.Provider` field is implicitly one — reading a value
discovered later gets an empty string or a bare `No such key`, depending on how the *other* module's
controller happened to write its snapshot. And a value learned during `run()` cannot be reported at
all: the only mechanism today is an accident, the kernel storing the props object by reference so a
controller that mutates what it returned becomes visible to CEL.

Scoped resources are worse off still — `createScopeHandle` spawns a plain `EvaluationContext` whose
snapshot hook is a no-op, so `resources.<scopedName>` resolves to nothing inside a `with:` block at
all, though `with:` is documented as "resources available during sequence execution".

## Solution

**Reporting.** `ResourceContext` gains `setStatus(status)` (`sdk/nodejs/src/resource-context.ts`,
implemented in `kernel/nodejs/src/evaluation-context.ts` beside the post-init capture). Configured
state stays pulled — `snapshot()` returns it and the kernel calls that whenever it needs the value,
since it is a function of the manifest. What the resource *learns* is pushed, because nothing but the
controller knows when it learned it. The kernel holds the last value reported, keyed by instance, and
publishes it until the resource is torn down.

**Declaring.** `Telo.Definition` and `Telo.Abstract` gain an optional `status:` JSON Schema block
(`kernel/nodejs/src/manifest-schemas.ts`, `analyzer/nodejs/src/builtins.ts`) describing what the
resource reports while running. It surfaces as its own segment: **`resources.<name>.status.<field>`**.
A controller reports it with `ctx.setStatus(...)`; the kernel exposes it at that segment. Only a kind
that declares `status:` reserves the key — it may not also return a flat `status` field
(`ERR_OBSERVED_STATE_KEY_COLLISION`); a kind that declares none may use the name freely. The flat half —
`resources.<name>.<field>` — keeps whatever meaning it has today (a Provider's provided value, a
config echo, or nothing) and stays permissive; this plan neither types it nor changes it, except for
scoped resources, which currently publish nothing at all (below).

**Reading.** The availability rule is structural, which is what the separate segment buys: *any path
through `.status` is illegal in a field that resolves at startup* (`x-telo-eval: compile`, or implied
by `Telo.Provider`). That check is purely syntactic — it inspects the access chain, not the topology —
so it applies to every kind, declared or not, and needs none of the typing work below.

Unknown-field checking under `.status` does need typing. The analyzer builds a `resources` context
schema from the resolved topology — resource name → kind → that kind's `status:` — including the
two-level `resources.<Alias>.<name>` shape for imported exported instances. The root and each
resource node stay `additionalProperties: true`, so unknown resource names and every flat field keep
passing exactly as today; only the `status` node is typed, and only for kinds that declare the block.
Nothing that validates today can start failing.

Ordering is not decidable in general — a handler can be invoked from anywhere, so a runtime-evaluated
read may legitimately run before the producing resource has started. What *is* decidable is whether a
resource can run at all: `runTargets` is the only path that calls `run()`, so a resource named in no
`targets:` list — the application's or a `Run.Sequence`'s — never runs, and a `.status` read of it is
wrong by construction. **Statically** the analyzer rejects exactly that, reported at the reading
expression and naming the `targets:` to add it to. This subsumes the `with:`/`targets:` case and
removes the most common way the runtime error would otherwise be reached.

What remains is genuine ordering, and a resource that ran but reported nothing. The kernel knows which
it is — it records whether a resource's `run()` completed — so **at runtime** these are two different
errors, never one hedge covering both. A resource that has not started names the `targets:` entry and
declaration site to change. A resource that *has* started but reported no value for a field it
declares is a defect in the producing module, and the error says so and names that module, because no
edit to the reading manifest can fix it. Neither case ever yields an empty value or a bare key error.

**Scopes.** `createScopeHandle(...).run()` spawns a fresh child `EvaluationContext` per run, so each
run carries its own resources map — two concurrent runs of the same sequence never observe each
other. The child's map layers over the parent's with scope-local names winning, matching the order
`ScopeContext.getInstance` already uses for `!ref` resolution, so CEL and references agree. Scoped
names resolve only inside the regions `x-telo-scope` annotates (`/steps`, `/targets`); outside them
the name does not resolve at all, which is today's rule for references and needs no separate lifetime
story once the scope exits. This is a genuine behaviour change for the flat half of scoped resources:
they publish nothing today and will publish like any other resource.

**Validation** checks each reported value against `status:` at the `setStatus()` call that made it —
one shape, one target, one place. An invalid claim is refused where it was made rather than surfacing
at some later publication. No validation dial is introduced and none is depended on.

**Adoption.** Declaring `status:` — even empty — opts the kind into typed `.status` reads. Kinds that
declare nothing behave exactly as they do today. Nothing in the standard library declares `status:` in
this change; `OAuthClient.RedirectListener` is the first consumer.

**In the editor**, `status:` is one more schema the CEL completion source reads: completing
`resources.<name>.` offers the reported fields under `status`, and a field being completed in a slot
that resolves at startup does not offer the segment at all — the same schema drives both, so there is
nothing kind-specific to teach it. Dependency drawing is unaffected: a `.status` read is an edge to
the same resource, just a deeper path.

The change spans `@telorun/sdk`, `@telorun/kernel` and `@telorun/analyzer` under one changeset, and
carries the documentation it obliges: the new manifest field and the CEL segment in `kernel/docs/`,
the matching update to the authoring agent's primer (`apps/authoring-agent/chat/telo.yaml`), and a
`CLAUDE.md` correction — its lifecycle section currently documents the by-reference aliasing as the
way "a service reports an address it only learns when it runs", which is precisely what this replaces.

## Decisions

- **Observed state flows into calls, never into configuration** — a resource is created before
  anything runs, so a field that resolves at startup can never take a reported value; the consumer
  reads it at the call site instead (a step's `inputs:`, an invoke-time field like `Http.Request`'s
  `url`, a handler, a `returns:`). Deferred creation — letting a resource whose config reads `.status`
  initialize after its producer runs — would lift the restriction, but it makes resource creation
  interleave with execution, which is a lifecycle change far larger than this plan and is deliberately
  left for its own.
- **Observed state gets its own CEL segment; the flat half is neither typed nor changed** — rejected:
  typing the flat half as `schema: ∪ status:`, which would promise config fields the runtime does not
  publish (52 of 70 standard-library controllers return an empty snapshot; `Http.Client` is the
  outlier, not the pattern). Rejected: `spec` / `status` segments, since Telo deliberately has no
  `spec:` wrapper in manifests and every existing read is flat. Rejected: a separate `status.<name>`
  root, which splits one resource across two namespaces the editor must re-join, and breaks the
  `steps.<name>.result` precedent of hanging a sub-namespace off the thing it belongs to.
- **The availability rule is syntactic; only unknown-field checking needs the topology** — so the rule
  and the runtime error protect every kind immediately, while typing degrades gracefully for kinds
  that declare nothing. The `resources` root stays permissive at both levels so no manifest that
  validates today can begin to fail.
- **Everything under `status:` is unavailable until the application runs; no per-field annotation** —
  `init()` performs no I/O, so a resource discovers nothing there, and the segment makes the rule
  structural rather than a property of each field. Reporting before the resource starts is an error
  (`ERR_OBSERVED_STATE_BEFORE_START`), not a discarded value: with reporting pushed it is a deliberate
  act, so refusing it says more than silently dropping it.
- **Every declared observed field is mandatory once the resource has run; `required:` is rejected** —
  a field that is genuinely sometimes-absent is declared with a nullable type instead, which the
  existing `CEL_NULLABLE_ACCESS` machinery already guards. That keeps reads non-nullable without a
  guard, and keeps the "has not reported it yet" runtime error truthful rather than covering for a
  resource that ran and legitimately reported nothing.
- **Reading unreported observed state is a hard runtime error, not an empty value** — today the
  outcome depends on whether the producing controller happened to pre-fill the key, which makes
  correctness a property of another module's implementation style.
- **The two runtime causes get two messages, chosen from recorded run state** — "not started" and
  "started but reported nothing" need opposite actions from the reader: edit your `targets:`, versus
  report a defect in someone else's module. A single message covering both would name a goal rather
  than an action, and would send the second reader to audit a startup order that is already correct.
- **"Can never run" is a static error; "ran in the wrong order" is a runtime one** — a resource named
  in no `targets:` list anywhere can never report anything, and that is decidable from the manifest
  alone, so it is reported at the reading expression. Rejected: general ordering analysis, which needs
  whole-program flow analysis and would reject valid manifests. The one false positive this admits is
  a controller that starts a sibling through `ResourceContext.run` — no module does, and doing so
  hides the boot sequence from the manifest, so it is treated as the error it looks like.
- **Scope maps are per run, scope-local names win, and scoped names resolve only inside the scope** —
  a fresh child context per run is what the scope handle already builds, so concurrency falls out; the
  shadowing order matches `!ref` resolution so CEL and references never disagree; and confining reads
  to the annotated regions removes any question about what a read after scope exit means.
- **Allowed on `Telo.Abstract`, inherited through `extends`** — a contract can mandate what its
  implementations report. A child without `base:` merges the parent's `status:`; a child with `base:`
  publishes the parent's unchanged, since it *is* a parent instance.
- **Validated on every publication path** — rejected: skipping the post-invoke refresh for speed, which
  would make the declared shape a guarantee on some paths and not others in exchange for one AJV check
  on a path that already calls `snapshot()`.
- **Configured state is pulled, observed state is pushed** — two values with one writer each, not one
  value with two writers. `snapshot()` is a function of the manifest, so re-deriving it on demand is
  always correct; what a resource learns has no such derivation, and only the controller knows when it
  changed. Rejected: notify-and-pull for both (`refreshSnapshot()` with no argument, the reserved
  `status` key inside `snapshot()`). It reads worse — the controller stashes a field whose only
  purpose is letting `snapshot()` rebuild what it already knew — and it forces a reserved key on every
  kind, whose collision case is not statically decidable because nothing declares the flat half. The
  `useSyncExternalStore` precedent does not transfer: that is one store with one shape, which is the
  case where notify-and-pull wins.
- **Reporting replaces rather than merges** — "this is my observed state now". Merging would put the
  published shape in two places again, and since every declared field is mandatory once the resource
  has run, a partial set would leave a value that violates the contract. A sometimes-absent field is
  declared nullable and reported as `null`.
- **A reading is sticky until teardown** — set once, published until the instance dies; a dispatch
  that reports nothing leaves the previous reading in place, because a listener's bound address does
  not stop being true between calls. Rejected: clearing at the start of each dispatch, which would
  wipe a Service's address on the next invoke and has no well-defined moment for a Service whose
  `run()` never returns. Rejected: a `clearStatus()` verb — the nullable-type rule above already
  expresses "nothing this time", and a second spelling would only invite disagreement.
- **Rejected: leaning on the existing by-reference aliasing** — it works today, but it is an
  implementation accident that a defensive-copy refactor breaks silently, it is Node-only by
  construction, and it gives the kernel no moment at which to validate what was published.
- **Rejected: `kernel/specs/signals.md`** — a signal is an edge to a listener with no retained value,
  so it would deliver a value without making `resources.<name>` readable, and would turn a data
  dependency into a control dependency.

## Complete example after the change

A kind that reports what it discovers. `port` is what the author asked for; `status.port` is what the
socket got — the segment keeps them apart, so neither needs renaming:

```yaml
kind: Telo.Definition
metadata:
  name: RedirectListener
capability: Telo.Service
schema:
  type: object
  properties:
    port:
      type: integer
      description: Pin a port; omit to let the OS choose one.
status:
  type: object
  properties:
    port: { type: integer }
    redirectUri: { type: string }
```

Read at a call site — accepted:

```yaml
steps:
  - name: auth
    invoke: !ref authorization
    inputs:
      redirectUri: !cel "resources.loopback.status.redirectUri"
```

Read from a field resolved at startup — rejected where it is written:

```yaml
kind: Http.Client
metadata:
  name: browser
baseUrl: !cel "resources.loopback.status.redirectUri"
```

> `loopback` reports `redirectUri` while the application is running. `baseUrl` on `Http.Client browser`
> is resolved once at startup, so that value does not exist yet. Read reported values where the call
> happens — a step's `inputs:`, a request's `url`, a route handler, or a `returns:` expression.

A typo fails where it is written instead of resolving to nothing:

> `loopback` reports no `redirectUrl`. It reports `port`, `redirectUri`.

A resource that can never run is caught before the application starts:

> `loopback` reports `redirectUri` only while it is running, and it is never started. Add
> `!ref loopback` to the `targets:` of `Run.Sequence login`, which declares it.

And the two runtime causes read differently, because they need opposite actions:

> `loopback` has not started yet, so it has not reported `redirectUri`. It is listed in the `targets:`
> of `Run.Sequence login`; this value is read before that sequence runs.

> `loopback` has started but reported no `redirectUri`, which `OAuthClient.RedirectListener` declares
> it reports. This is a defect in the `oauth-client` module — no change to this manifest will fix it.
