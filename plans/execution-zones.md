# Execution zones

**Depends on `plans/typed-reference-graph.md`.** That plan supplies the typed call
graph — every ref slot's `use`, the shared graph service, the step model — and this
plan is its first consumer: zone semantics evaluated over edges something else
discovers. Everything this plan once carried about *classifying* slots
(`x-telo-dispatch`, the unclassified advisory, its CI gate, `x-telo-zone-breaking`,
the manifest × schema walk) now lives there.

## Status

**Landed.** Normative spec at `kernel/specs/execution-zones.md`; guide at
`docs/extend/execution-zones.md`; `sql`'s half at `modules/sql/docs/transactions.md`.

- **SDK** — `ZoneEntry`, `InvokeContext.zones`, `deriveContext`,
  `ResourceInstanceId` / `ResourceHandle` / `sameResource`, and the
  `ResourceContext` surface (`self`, `withZone`, `requireZone`, `findZone`,
  `zonesFor`, `rootContext`).
- **Kernel** — handle minted at `create()` (`resource-handle.ts`, no reverse
  direction); the zone half of `resource-context.ts` resolving both annotations in
  the kind's declaring scope; `deriveContext` at all four context-rebuild sites
  (`runInvoke`, `runInstance`, `runTargets`' `targetCtx`, `openSpan`).
- **Analyzer** — `zone-slot.ts` (the annotations' single reader),
  `resolve-zone-requirements.ts` (the projection + per-library export derivation),
  the host-lifetime cache threaded through `analyze()` into the editor, and the four
  diagnostics. `resolveSchemaRefKinds` canonicalizes the requirer's zone name in the
  same walk it canonicalizes `x-telo-ref`.
- **Modules** — `sql` moved onto zones (`txStorage` / `txMap` deleted,
  `assertActive()` deleted, executor map an instance field on the connection,
  `steps:` widened to `Telo.Executable`); `cache`'s `Cache.View.invoke` narrowed to a
  case map on `/revalidate`; `http-server`, `mcp-server` and `scheduler` dispatching
  through `rootContext`.
- **Tests** — 21 kernel zone-stack tests (each clearing/propagation assertion run
  with tracing on AND off), 23 analyzer projection tests, an end-to-end
  `bound-statement-in-transaction.yaml` across the bundle/npm delivery split, a
  per-connection nesting test, and 8 static-analysis assertions in
  `zone-static-analysis.yaml`.

**Fixed on the way, in the shared graph:** `buildCallGraph` resolved a resource's
definition by raw kind while manifests carry the kind as *authored*
(`Run.Sequence`) and the registry is keyed canonically (`run.Sequence`). Every
alias-form kind missed silently, so step collection found no step list (a step's
declared `use` never reached its edge, and the site degraded to an untyped
value-tree edge) and a case map's selector found no schema `default`. Definitions
now resolve in the declaring module's scope, matching
`expandedFieldMapForResource`.

**Not done, deliberately:** the two `sql` gaps under *What this plan does not do*
below, and `analyzer/rust`'s `resolve_zone_requirements.rs` — that half emits no
diagnostics at all yet, so `telo check` parity stays a pre-existing non-goal.

## Problem

A resource can require being invoked inside another resource's body, and Telo has no way
to say so — the requirement is discoverable only by running the path.

`Sql.Query`, `Sql.Command` and `Sql.Selection` take an optional `transaction:` reference.
Contrary to how it reads, that reference does **not** bind the statement to that
transaction. Executor selection is ambient: `Sql.Transaction` opens a transaction and runs
its body inside an `AsyncLocalStorage` scope, and `resolveExecutor`
(`modules/sql/nodejs/src/sql-connection-base.ts`) picks up whatever transaction is open on
that scope. The declared reference does exactly two things — derives a connection when
`connection:` is absent, and calls `assertActive()`, which throws when no transaction is
open.

That ambient behaviour is load-bearing, not a defect. It is what lets a library export a
sequence of writes that joins an importer's transaction without the library naming a
transaction it cannot see. Any design making membership explicit would break that
composition.

So the gap is not silent wrongness — `assertActive()` throws. The gap is **when**: a
manifest wiring a bound statement onto a path that reaches it outside any transaction is
only discovered when that path executes, possibly on a rare branch, possibly in
production. The whole answer is in the manifest.

**Two facts about today's runtime that the prerequisite must fix, and that any test
written against this section must assume** (both verified by running a manifest, not read
off the source):

- **`transaction:` currently throws on every path, including inside its own transaction.**
  `txStorage` is written by `SqlConnectionBase.transaction()` and read by
  `SqlTransactionResource.assertActive()`, and those two do not share a module instance:
  the transaction controller ships as a bundle that *inlines* `transaction-store.ts`,
  while the connection base is reached through `@telorun/sql` from the `pkg:npm`-delivered
  backend. Two `AsyncLocalStorage`s, so the write and the read never meet, and
  `Sql.Transaction 'X': used outside an active transaction` is the only outcome a bound
  statement has. This is a realm split, not a logic error — see *the payload rule* below,
  because the naive zone design reproduces it exactly.
- **Flat nesting never reuses.** The `if (currentTxId())` branch in the transaction
  controller reads the same empty store, so a nested `Sql.Transaction` always takes the
  open-a-transaction path rather than joining the enclosing one.

What is genuinely ambient-and-working today is the *unbound* statement: `resolveExecutor`
writes and reads `txStorage` on the same side of the split, which is why the shipped
transaction test omits `transaction:` and passes. The plan's value therefore includes
making the declared reference work at all, not only checking it earlier.

Durable execution has the same shape: a body that can park must be reached through the run
owning its journal, and a `Durable.Await` with no ambient journal can only throw. That is
the companion plan, and why this is a mechanism rather than a check bolted onto `sql`.

This is deliberately not `x-telo-scope`, which constrains *visibility*. These resources
are normally named and normally visible; what needs describing is which invocation paths
may reach them.

## Solution

**A zone is identified by the kind that provides it** — no new kind, no capability,
nothing instantiated. Only the requiring side ever writes that name, through the
alias-qualified grammar `extends` and `x-telo-ref` already use (`Self.Transaction`,
`<Alias>.<Kind>`), so a misspelling is a resolution failure rather than a silently
unenforced constraint. The providing side names no zone at all: the zone a slot
provides is the declaring kind, period. A provider-side `zone:` prop named the
declaring kind in every shipped case — pure redundancy — while making
provision-on-behalf-of expressible: a schema claiming its slot establishes another
module's zone asserts behaviour of a controller it does not own, the argument that
already rejected consumer-side overrides. The legitimate wrapper shapes need no such
claim — a template-form kind containing a `Sql.Transaction` has the provision derived
through its internals by the walk, and an `extends`-child inherits the parent's
annotation folded in the declaring scope, so it provides the parent's zone.

**Two annotations.** Both sit beside a slot's `x-telo-ref` and express the relation;
neither classifies dispatch — the slot's `use` already did:

- **`x-telo-provides-zone: true | <key>`** — on a body slot: dispatching through
  it establishes the declaring kind's zone. The value is the correlation key, never
  the zone: `true` establishes it uncorrelated; a key (below) names the kind's own
  field whose resolved reference the zone carries as
  its correlation payload. `Sql.Transaction.steps` declares `/connection`. If the
  provider side ever needs a second datum, the scalar forms alias into an object field
  later — the evolution path `x-telo-stream: true` reserves.
- **`x-telo-requires-zone`** — on a resource's field: the resource must be reached
  through such a zone. The string form names the zone kind, uncorrelated; the
  object form adds correlation and consequence: `{ zone: Self.Transaction,
  key: [/connection, /transaction/connection] }` means the enclosing zone's correlation
  payload and the requirer's own resolved key must be the same resource (below). Each
  side declares its own key, so neither infers a field name from the other; a key
  pointer that *traverses* a `!ref` does read a field of the referenced kind, and is
  therefore confined to a kind the declaring module owns (below). The optional
  `reason:` states the runtime consequence (`the statement would execute outside any
  transaction`), quoted by `ZONE_REQUIREMENT_UNSATISFIED` /
  `ZONE_EXPORT_UNSATISFIABLE` after the path. Optional, deliberately: those
  diagnostics' mechanical half is already concrete, so the completeness argument that
  makes the durable plan's exclusion `reason` mandatory does not transfer, and
  requiring it would kill the bare-string form. `Sql.Query.transaction` and its two
  siblings.

**Zone semantics are a projection of `use` — nothing is classified here.** The typed
graph already says, for every edge, when control reaches the target relative to the
declaring resource's invocation. Zones read that one fact:

- **`call`** — the enclosing zone's lifetime extends through the edge: requirements
  propagate callee→caller across it, and a providing slot discharges them.
- **`detached`** and **`trigger.inbound`** — the runtime *guarantees* a fresh ambient
  invocation context, which is where the zone stack lives, so the target provably runs
  outside every zone its caller was in (the mechanism, and what makes it a guarantee
  rather than an observation, is under *The runtime half* below). A requirement arriving
  at such an edge cannot be satisfied: **error**, `ZONE_REQUIREMENT_UNSATISFIED`,
  carrying the path.
- **`trigger.consumer`** — no guarantee either way: whoever drains the returned value
  decides where the dispatch runs, so a consumer draining inside a transaction genuinely
  is inside it. A requirement arriving here is `ZONE_REQUIREMENT_DEFERRED`, a
  **warning** with the same information, and the runtime assertion stays the real
  enforcement.
- **`dependency`** and **`schema`** — no edge; requirements neither enter nor leave.
  `Sql.Query.transaction` is exactly this: a dependency ref that *carries* the
  requirement without being a call.
- **Only a `use` resolved for the instance at hand may terminate a requirement.** A
  conditional `use` already resolves per manifest before zones look — the selector is
  statically resolvable by the typed-ref plan's rule — so a `Lease.Critical` instance is
  a `call` or a `detached` edge according to its own `detach:`. A **set**, though, is a
  property of the *slot*: it says the controller may dispatch several ways, not that
  this instance does. Propagation still needs every member to be `call`, but the error
  needs a guarantee no union can give, so a set with a non-call member **warns**
  (`ZONE_REQUIREMENT_DEFERRED`) instead of erroring. `Cache.View` is the case that forces
  this and also the case that should not need it: its `invoke:` declares
  `use: [call, detached]` unconditionally while `revalidate:` defaults to `sync`, under
  which the controller never detaches — so the union would hard-error every cached
  transactional call that works. It is re-annotated as a case map keyed on
  `/revalidate` whose cases are *sets* (`background: [call, detached]`, `sync: call`,
  `off: call`), which the case-map form already allows and which is the honest reading:
  `background` adds the detached dispatch, and the other two do not. Where a union
  genuinely cannot be narrowed, the warning is the correct severity.
- **An edge whose `use` is unknown neither propagates nor terminates — it warns.** Three
  such states survive the prerequisite: a ref found by the value-tree scan (no schema, so
  no `use` by construction), a case map whose selector is `absent` or `unmatched`, and —
  until the bare-string form is removed — an unannotated slot. The graph reads all three
  as control-transferring, which is the conservative direction for throws and
  reachability and the *wrong* one for zones: propagating through them would invent
  requirement paths, and terminating on them would invent failures. So a requirement
  reaching one stops with `ZONE_REQUIREMENT_DEFERRED`, whose message names why it could
  not be decided (undeclared slot / unresolved selector) rather than a drain site. A
  `dynamic` selector is already a hard diagnostic in `validate-ref-slots.ts`; zones do
  not re-report it.
- **Boot is the root**: nothing encloses an Application's `targets:`, so an open
  requirement surfacing at a boot entry errors there.

**The runtime half: the zone stack rides the ambient invocation context.** What `sql`
implements privately today — a module-global `AsyncLocalStorage` of open transactions —
becomes a kernel facility, and specifically **not a second ambient store beside the
cancellation scope**: the zone stack is carried *on the `InvokeContext` the kernel
already makes ambient*. That choice is what turns "cleared" from a list of sites
somebody has to remember to wire into the default state of the world:

- `ctx.runDetached` already replaces the ambient context with the uncancellable root, so
  a detached dispatch sheds every zone with no zone-specific code at all.
- A `Telo.Service`'s `run()` is deliberately dispatched with **no** ambient scope — the
  kernel's existing rule, so that a long-lived service does not leak its boot scope onto
  every socket callback. Every inbound trigger that ships (`Http.Api` routes,
  `Mcp.Server` tools, `Schedule.Cron` / `Interval`) is registered by a Service and is
  therefore already zone-free by construction.
- Nothing rides tracing. An earlier revision placed the clearing at "inbound span
  openings"; `openSpan` is a *tracing* facility that returns a pass-through when tracing
  is off and that exactly one controller calls, so a safety guarantee hung on it would
  be off by default and absent for timers.

**A zone entry is three identities and nothing else.** It names the providing kind, the
providing instance, and — for a correlated zone — the instance the provider's key pointer
resolved to. No provider-private payload rides on it: `sql` needs its kysely `Transaction`
reachable from the entry and keeps it in its own map, so the executor never becomes
readable by every controller in the process and the kernel contract stays serializable.

**The payload rule: provider-private state hangs off an INJECTED INSTANCE, never a module
import.** A module's controllers are delivered as separate bundles, each *inlining* its
copy of every shared source file, so a `const map = new WeakMap()` at module scope in
`transaction-store.ts` is not module-private — it is one map **per controller bundle**.
That is the live `sql` bug above, and the naive zone design reproduces it exactly: a
`WeakMap<ZoneEntry, Kysely>` written by the transaction controller and read by the
connection base would be two maps, and `resolveExecutor`'s `?? this.db` fallback would
turn every miss into *silently non-transactional* execution — strictly worse than today's
loud throw, and precisely the silent wrongness the Problem section says does not exist. So
the state lives as an **instance field on the resource that already crosses the boundary
by reference** (the connection, injected into both), and the provider hands the entry to
it. Entry identity itself is realm-safe by construction: the kernel mints the entry, both
sides receive the same object, and nothing in the contract uses `instanceof` — the whole
reason `ResourceInstanceId` is a compared string. This is normative in
`kernel/specs/execution-zones.md`, not a `sql` note: every future zone-bearing module with
separately-delivered backends meets the same split, and realm collapse cannot rescue it
(an inlined source file leaves no import to redirect).

```ts
// sdk/nodejs/src/cancellation.ts — beside InvokeContext
export interface ZoneEntry {
  readonly kind: string; // canonical `<module>.<Kind>` — what a requirement names
  readonly provider: ResourceHandle;
  readonly key?: ResourceHandle; // absent = uncorrelated zone
}

export interface InvokeContext {
  readonly cancellation: CancellationToken;
  readonly invocationId?: number;
  readonly parentInvocationId?: number;
  readonly traceId?: string;
  /** Zones open around this invocation, outermost first. Absent = none. */
  readonly zones?: readonly ZoneEntry[];
}
```

**Instance identity is a typed handle, never the instance.** A bare object reference
would type nothing, would hand any controller a live reference to another module's
instance out of the ambient stack, and could not cross the ABI — so the same contract
would be unimplementable in the Rust kernel.

```ts
// sdk/nodejs/src/resource-instance.ts — beside RefIdentity
/** Kernel-minted, unique per LIVE instance, stable for its lifetime. Distinct from
 *  RefIdentity: a `with:`-scoped resource has one declaration and one instance per
 *  scope run, and correlation must see those as different. */
export type ResourceInstanceId = string & { readonly __brand: "ResourceInstanceId" };

export interface ResourceHandle {
  readonly id: ResourceInstanceId; // the only thing compared
  readonly ref: RefIdentity; // where it was declared — diagnostics only
}
export const sameResource = (a: ResourceHandle, b: ResourceHandle) => a.id === b.id;
```

The id is minted at `create()` — the kernel's single instance-production site, where the
invocation contract already binds — so an instance is never observable without one. The
kernel holds instance → handle in a `WeakMap`; **the reverse direction deliberately does
not exist**, which is what stops a handle from being turned back into someone else's
instance. `ref` is what lets the runtime error say *no `sql.Transaction` open on
connection `appDb`* instead of printing an id, and costs nothing: the kernel already
stamps `RefIdentity` at injection.

**A controller names its own annotation site, never a kind.** This is forced, not
stylistic: a controller has no alias scope of its own. `ctx.moduleContext` is the scope
that *owns the resource* — the consumer's application, not the module that declared the
kind — so `Self.Transaction` there would resolve to the consumer, and `resolveKind` is not
on the controller surface at all. The only string a controller could otherwise write is a
canonical `"sql.Transaction"`: another module's `metadata.name` hand-copied into code,
which is precisely the annotation/controller disagreement this design exists to prevent.
So the zone kind and the correlation key are **derived by the kernel from the annotation**,
and the controller supplies only the one thing the schema cannot know — *where in its
execution the zone opens*:

```ts
// ResourceContext
/** This resource's own handle. Its `ref` is how a controller names itself in a
 *  diagnostic; its id is what the kernel stamps as a zone's `provider`. */
readonly self: ResourceHandle;

/** Open the zone declared by this resource's `slot` (`x-telo-provides-zone`) around
 *  `fn`. Kind = the declaring kind; correlation key = the annotation's pointer,
 *  resolved against this resource's own manifest. Throws if `slot` carries no such
 *  annotation — a controller and its schema disagreeing is a defect, not a fallback. */
withZone<T>(
  slot: string,
  fn: (ctx: InvokeContext, entry: ZoneEntry) => Promise<T>,
): Promise<T>;

/** The zone required by this resource's `field` (`x-telo-requires-zone`), or throw
 *  ERR_ZONE_REQUIRED. Reads the ambient stack unless `ctx` is given. */
requireZone(field: string, ctx?: InvokeContext): ZoneEntry;
findZone(field: string, ctx?: InvokeContext): ZoneEntry | undefined;

/** Ambient zones correlated on an instance the caller holds, innermost first — the
 *  undeclared case (a statement with no `transaction:` still joins an open one). */
zonesFor(instance: ResourceInstance, ctx?: InvokeContext): readonly ZoneEntry[];
```

Both annotation-driven calls resolve through the kind's *declaring* module, the same scope
`x-telo-ref` constraints are rewritten in at registration, so an alias never has to survive
into code. `zonesFor` needs no kind because the provider's own per-instance map already
discriminates: a zone this connection did not open simply misses.

A **scope function rather than a push/pop pair**: push/pop cannot be honest across async
boundaries, and this matches `runDetached` / `withManifests`. It hands the derived context
to `fn` instead of only installing an ambient, because the controller must thread it into
`invokeResolved` for the body — the discipline cancellation already has. It also hands
back the minted `ZoneEntry`, which is what a provider with private state (an open
transaction, a journal) keys its own map on. **Every field of the entry is derived**:
`kind` and `key` from the annotation, `provider` from the owning resource — which is the
runtime half of why a schema cannot claim to provide another module's zone, and what makes
the two halves impossible to disagree.

**One derived-context constructor, and it is a correctness requirement.** The kernel
rebuilds the context as a fresh object literal in three places — `runInvoke`'s tracing
branch, `runInstance`, and `runTargets`' `targetCtx`. Adding `zones` naively means the
stack survives with tracing off and vanishes under `--debug`: a safety property that
changes with a debug flag. Every one of those sites goes through a single
`deriveContext(base, overrides)`, with a test asserting propagation is identical tracing
on and off.

**The one obligation the default does not cover** is a `trigger.inbound` registered from
*inside* an invocation by something that is not a Service — nothing structural clears the
platform's propagated context there. The mechanism already exists: an explicit
`InvokeContext` argument **fully replaces** the ambient at dispatch, and every shipped
inbound registrant already mints one because it needs a per-request cancellation source.
What is missing is a name, so the spec can point at an API and a reviewer can see its
absence:

```ts
/** The root context for runtime-driven inbound work (request, timer, queue message):
 *  inherits nothing from whatever ambient happens to be live at the registration
 *  site — no zones, no trace parent, no caller token. */
rootContext(opts?: { cancellation?: CancellationSource }): InvokeContext;
```

An inbound registrant dispatches with `rootContext()` (or a cancellation source's
context, which is one), never `undefined`. That is what backs the *error* severity on
`trigger.inbound` edges — a stated obligation with conformance tests, not the current
population of inbound kinds all happening to be Services.

The contract is normative in `kernel/specs/execution-zones.md` (the invocation-contract
precedent): it binds every controller of a kind including a second language's — `console`
and `starlark` already ship dual Node/Rust controllers — and a manifest-facing promise
enforced only by one implementation's tests is not a contract. Two things the spec pins
for the Rust half specifically: a zone stack is **two strings and a declaration label per
entry**, so it serializes across the ABI with no realm-crossing references (the reason
`ResourceInstanceId` is a string), and the derived-context rule above is normative rather
than a Node implementation detail. The payload rule is normative for the same reason: a
module whose controllers ship in several bundles has no module-global state, in either
language. `kernel/rust` passes its invocation context explicitly
and has no ambient store, so "cleared" is the absence of a field there — the property
holds by construction. This is also what gives
declared edges teeth: a wrong `use: call` in a schema the consumer cannot edit degrades
to the existing runtime error at the right place, instead of the timing-dependent silence
`txStorage` allows today. Residue, stated: work fired outside the kernel's primitives (a
bare floating promise) still inherits whatever the platform propagates — but such work is
already outside detached-task tracking and teardown draining, a pre-existing contract
violation rather than a new hole.

**Prerequisite: the `sql` connection-identity fix lands first, implemented on that
kernel state.** Today `resolveExecutor` reads the global ambient transaction id with no
connection check, so a statement declared on connection B inside connection A's
transaction executes on **A's** connection. As the preceding change, `Sql.Transaction`
opens a zone entry carrying its connection's identity, and both the executor lookup and
the requirement check consult the stack *per connection* — retiring `txStorage`/`txMap`;
nesting flattens only into a same-connection ambient transaction, and a different
connection opens its own. Four defects fall out at once:

- **the realm split** — `transaction:` throwing on every path, because the zone stack is
  kernel-owned and the executor moves onto the connection instance (the payload rule), so
  neither side depends on two controllers sharing a module instance;
- **flat nesting never reusing** — the same fix: the enclosing zone is visible to the
  nested transaction because the kernel carries it, not a per-bundle store;
- **cross-connection execution** — the ambient lookup is keyed by connection;
- **the detach race** — a detached dispatch sheds the zone at the kernel primitive, so a
  statement inside it deterministically sees no transaction instead of racing the commit
  for a dying executor.

Sequencing this first is what lets scoping be decided against the intended
semantics: a type-scoped check over today's runtime would report **clean** on exactly
the corrupting case, which reads as confirmation of the wiring.

**`Sql.Transaction.steps` widens from `Telo.Invocable` to `Telo.Executable`, and that is
load-bearing for everything below.** `Run.Sequence` is a `Telo.Runnable`, so today the
slot rejects it (`REFERENCE_KIND_MISMATCH`) — while the only shape today's constraint
accepts, a bound statement wired directly as `steps:`, is an init-order cycle against that
statement's own `transaction:` ref (both are Phase-5 injection sites). Which is why the
one shipped transaction test deliberately omits `transaction:`. So **no manifest can
currently express a bound statement inside its own transaction at all** — not the plan's
examples, not its tests, not the flagship diagnostic's subject. Widening the slot is a
one-line schema change that dispatch does not notice (`Run.Sequence` exposes `invoke()`,
and `Telo.Executable` is the prerequisite plan's slot abstract for exactly this), and it
breaks the cycle because a step's `invoke:` is not an injection site. It is listed as its
own implementation item with its own `sql` fragment rather than left to be discovered
mid-implementation.

**Requirements are type-scoped and connection-correlated.** An enclosing zone
discharges a statement's requirement when its declaring kind is, or `extends`, the
required kind — the Liskov acceptance `x-telo-ref` slots already have — *provided the
correlation holds*: the zone's correlation payload (the provider kind's `key` field)
and the requirer's `key` field must resolve to the same resource.
Checkable, because both sides are static refs — and it is the static counterpart of the
runtime fix, under which a statement inside a transaction on a different connection is
simply not transactional. **Correlation identity is the connection's resolved
declaration site**, which mirrors runtime instance identity exactly. For a named
module-level resource that spells `(declaring file, resource name)` — deliberately the
*declaring* file rather than the owning module name, because a re-exported instance is
forwarded as one copy per re-exporting module, each stamped with that module's name while
the declaration site is carried through unchanged. Keying on the module name would make
one connection reached through two hops compare as two; keying on the declaration site is
what makes the same connection reached under different aliases compare equal across
module boundaries. A `with:`-scoped
connection's identity is its scope site plus name: provider and requirer inside the same
scope correlate; a scoped requirer against a module-level provider does not — correctly,
they are different connections. An inline `{ kind }` declaration is its own identity:
two inline declarations are two runtime instances, so a statement on an inline
connection inside a transaction on any other connection fails correlation statically,
exactly as the fixed runtime would leave it non-transactional. Type-scoping rather than
binding to the *named* transaction is what keeps a body containing a bound statement
reusable across transactions; membership stays ambient, now per connection.

**A key is an ordered list of pointers, because the correlated field is usually
absent.** `connection:` is *optional* on `Sql.Query` / `Command` / `Selection` — only
`sql` / `from` are required — and the idiomatic statement omits it, letting the
controller derive one from the transaction it names
(`resolveSqlConnection(connection) ?? transaction?.getConnection()`). A single
`key: /connection` would therefore resolve to nothing in the **common** shape, leaving
correlation undefined exactly where it matters. So a key is one self-relative JSON
pointer or a list of them tried in order, first hit winning, and a pointer may traverse
a `!ref` into the referenced resource's own field: the statements declare
`key: [/connection, /transaction/connection]`, which is the manifest-level transcription
of that `??`. Traversal is mechanical (read field → resolve sentinel → read field), so
the analyzer names no kind; what derivation exists is declared by the module author who
owns the controller. **A traversing pointer is confined to a kind the declaring module
owns** — `Sql.Command` may read `Sql.Transaction.connection` because one author owns
both — and naming a field of a kind from another module is a diagnostic
(`ZONE_PROVIDER_UNRESOLVED`), because that is the one shape where the annotation would
depend on a field name its author cannot keep true. When **no** pointer resolves, the requirement discharges
uncorrelated — any zone of the right type satisfies it — the under-approximating side
the whole check leans on, since inventing a correlation the manifest does not state
would manufacture errors from a guess.

**A slot may be both terminating and providing** (`Durable.Run.invoke`, a `detached`
provider): incoming requirements fail there, except the zone it provides.

**An open requirement crosses a library boundary as a contract, derived per library in
its own analysis stage.** A `Telo.Library` cannot see its importers, so an exported
resource with an open requirement is a contract for them to satisfy. But the set is not a
declared list the way `stampExportedKinds`'s input is: open requirements must be *derived*
by running the zone projection over the library's internal graph — and the flattened
analysis view no longer holds that graph, because `selectModuleManifestsForAnalysis`
forwards an importer just the export surface (definitions, abstracts, imports,
`exports.resources` instances), never the internal dispatch chain. The pruning happens at
flatten, not at load: the importer's own loader still holds every imported library's full
documents.

**Where the derivation runs matters, and it is not flatten.** Flatten is manifest
*selection* — it takes a `LoadedGraph` and returns documents — and the definition registry
and alias resolvers the projection needs are built *from* its output, so running a call
graph there inverts the staging. It also sits on the wrong side of flatten's own rule that
an imported module's internals belong to that module's analysis pass. So the projection is
its own stage inside `analyze()`, after registries exist: for each imported library it
builds the library-scoped graph from the loaded documents, runs the projection, and
attaches the derived open set to that library's export surface; the importer's diagnostic
passes read the attached set exactly as they read `metadata.exportedKinds`.

**Cached in a host-lifetime cache passed into `analyze()`, keyed on
`(source identity, content signature)`.** Two constraints fix this, and neither is
negotiable. It cannot live in `AnalysisRegistry`: the editor constructs a fresh one **per
closure, per analysis run** (`apps/studio/src/analysis.ts`), so a cache there dies at
exactly the boundary it exists to cross — it would not even survive two closures of one
run. And the key cannot be source identity alone: a **workspace** library's documents
change between runs precisely because the user is editing them, so an identity-only key
serves a stale export contract. The signature is over the library's own loaded documents,
which the loader already holds; a published library hits every time (its bytes are
immutable), a workspace library invalidates by construction on the keystroke that changed
it. The cache is threaded in beside the existing optional pre-seeded registry, so the
editor owns its lifetime and the CLI passes none. This is a performance requirement, not
an optimization to defer — the editor re-analyzes on every keystroke and would otherwise
rebuild every dependency's graph each time. (The existing analysis stamp is a single
whole-graph signature per entry carrying no payload, so there is nothing to ride.)

**Reporting is one-sided.** An exported resource whose requirement correlates on a
resource importers cannot reach — a library-internal, unexported connection — is
unsatisfiable from outside by construction, and `ZONE_EXPORT_UNSATISFIABLE` is raised at
the *library's own* check, the desk of the one author who can fix it. An importer's run
derives the same set (it needs it) but never reports that diagnostic against a file it
does not own.

**Relationship to `throws:`.** Both are consumers of the same typed graph after the
prerequisite plan, so they finally share edge discovery. The analyses stay separate:
opposite polarity (throws over-approximates what may be thrown; zones under-approximate
what is provably reached), different discharge sites (a `catch` vs a providing slot).
Each keeps its own traversal over the shared edges; only the graph is common.

**What this plan does not do.** It does not make transaction membership declarative —
after the prerequisite, membership is still ambient, just per connection, so a statement
bound to transaction A executed inside transaction B *on the same connection* still runs
in B (`assertActive()` still asserts presence, not the named identity). And there is
still no way to assert "must be transactional" without naming a transaction, since the
assertion rides the `transaction:` field. Both stay tracked `sql` gaps.

## Implementation

- **Kernel + SDK** (the sequenced prerequisite), in order:
  1. `ResourceInstanceId` / `ResourceHandle` / `sameResource` in the SDK; the id minted
     at `create()` and the instance → handle `WeakMap` in the kernel (no reverse
     direction); `ctx.self`.
  2. `ZoneEntry` and `InvokeContext.zones`, plus the single
     `deriveContext(base, overrides)` every context-rebuilding site moves onto —
     `runInvoke`'s tracing branch, `runInstance`, `runTargets`' `targetCtx` — with the
     tracing-on/off parity test.
  3. `ctx.withZone(slot)` / `requireZone(field)` / `findZone(field)` / `zonesFor(instance)`
     — annotation-driven, resolving the declared zone kind (`extends`-aware) and the
     correlation key in the kind's *declaring* scope — and `ctx.rootContext`;
     `ERR_ZONE_REQUIRED`, plus the defect error when a named slot carries no annotation.
  4. `modules/sql` moved onto it: `txStorage`/`txMap` retired, the executor in a
     `WeakMap<ZoneEntry, Kysely>` **instance field on the connection** (never a module
     global — the payload rule), the transaction controller binding the entry through
     `runInTransaction`, the statement controllers requiring through their `transaction`
     field, `resolveExecutor` reduced to an instance-keyed ambient lookup that throws
     rather than falls back on an unknown explicit zone (so `SqlConnectionBase` gains a
     `ResourceContext`, which it does not hold today), and `assertActive()` deleted.
  5. `Http.Api` (and any other inbound registrant) dispatching through `rootContext`.

  Normative contract in `kernel/specs/execution-zones.md`. Nothing hangs off `openSpan` —
  tracing is not a safety mechanism.
- **Analyzer**: `resolve-zone-requirements.ts` — a **consumer of the call-graph
  service**, no traversal of its own: it filters the graph's edges by `use`, propagates
  requirements along `call` edges with memoization and cycle short-circuit, discharges
  at providing slots under the correlation rule, and fires at terminating edges and at
  boot. Per-library export derivation runs as its own stage in `analyze()` (after the
  registries exist, never in `flatten-for-analyzer.ts`), cached in the host-lifetime
  cache below. Diagnostics:
  `ZONE_REQUIREMENT_UNSATISFIED` (error, with the path and zone),
  `ZONE_REQUIREMENT_DEFERRED` (warning, same information, at a `trigger.consumer` edge,
  at an unnarrowable `use` set with a non-call member, and at an edge whose `use` is
  unknown — the message naming which of the three it is),
  `ZONE_EXPORT_UNSATISFIABLE` (error, at the exporting library only),
  `ZONE_PROVIDER_UNRESOLVED` (mirroring `X_TELO_REF_UNRESOLVED`; also raised when a
  correlation `key`'s every pointer names no property of the declaring schema, and when
  a traversing pointer reaches into a kind the declaring module does not own).
- **`Sql.Transaction.steps` widened to `Telo.Executable`** (from `Telo.Invocable`), with
  its own `sql` fragment. Without it no manifest can put a bound statement inside its own
  transaction — a `Run.Sequence` is rejected at the slot and the direct wiring cycles — so
  every example, every manifest test and the flagship diagnostic depend on this landing.
  A manifest test wiring `Run.Sequence` into `steps:` is what proves it.
- **Analyzer**: per-library export derivation takes a host-lifetime cache parameter on
  `analyze()`, keyed `(source identity, content signature)`; the editor owns it, the CLI
  passes none.
- **Annotated kinds** — only providers and requirers; every slot's `use` is the
  prerequisite plan's migration, not this one's. Providing: `Sql.Transaction.steps`
  (`x-telo-provides-zone: /connection`). Requiring (`zone: Self.Transaction`,
  `key: [/connection, /transaction/connection]`): `Sql.Query.transaction`,
  `Sql.Command.transaction`, `Sql.Selection.transaction`. The durable plan adds
  `Durable.Run.invoke` (providing, on a `detached` edge) and `Durable.Sleep` /
  `Durable.Await` (requiring).
- **One `use` narrowed** — `Cache.View.invoke` moves from the unconditional set
  `[call, detached]` to a case map on `/revalidate` with set-valued cases
  (`background: [call, detached]`, `sync: call`, `off: call`). It is not zone-specific
  bookkeeping: the union overstates what the controller does under the default `sync`,
  and every consumer of the graph reads it. Changie fragment for `cache`.
- **Tests**: kernel tests for the zone stack (`withZone` nesting and unwinding on throw,
  connection-keyed consult, `extends`-aware kind matching, shed by `ctx.runDetached`,
  absent inside a `Telo.Service`'s `run()`, rooted afresh by `rootContext` — the last
  three asserted with tracing **on and off**, since the derived-context rebuild is where
  a silently-dropped stack would come from, and it is also the regression that would
  have followed from hanging clearing on `openSpan`); two live instances of one
  `with:`-scoped connection correlating separately; **a bound statement executing
  transactionally end-to-end across the bundle/npm delivery split** — the regression test
  for both today's realm bug and any future reintroduction of module-global zone state,
  and the one test that must run against the real `sql-sqlite` backend rather than a
  stub; a nested `Sql.Transaction` reusing the enclosing one on the same connection and
  opening its own on a different one; manifest tests
  for satisfied, unsatisfied-at-a-route, unsatisfied-at-boot,
  reused-across-two-transactions, cross-connection correlation failure,
  open-across-an-import, a requirement on a `with:`-scoped statement satisfied
  inside its scope, an inline-connection correlation failure, a statement omitting
  `connection:` correlating through `/transaction/connection` (and a mismatch on that
  derived path failing), a requirement reaching a `trigger.consumer` edge producing the
  warning and **not** the error, a `Lease.Critical` requirement path in both `detach:`
  modes, a requirement through a default-configured `Cache.View` producing **no**
  diagnostic (and its `background` sibling producing the warning), a requirement reaching
  a value-tree-discovered ref warning rather than erroring, and a requirement propagating
  out of a step nested three levels deep (`try` inside `catch` inside a step) — the
  zone-side check that the graph's step descent feeds this consumer. Analyzer unit tests
  for propagation cycles, the per-library export cache (same library analyzed twice
  builds one graph), and terminating-plus-providing on one slot.
- **Release and docs**, all mandatory: changesets for `@telorun/kernel`, `@telorun/sdk`
  and `@telorun/analyzer`; changie fragments for `sql` (the behaviour fix in the
  prerequisite, then the annotations); the two annotations documented in `docs/extend/`
  and `modules/sql/docs/`; the authoring-agent primer
  (`apps/authoring-agent/chat/telo.yaml`) synced.

## Decisions

- **The runtime enforces, the analyzer warns early** — with the zone stack
  kernel-owned, enforcement is deterministic at the dispatch, so the static half may
  under-approximate without becoming unsound: `ResourceContext.invoke(kind, name, …)`
  lets a controller dispatch by a name the analyzer cannot see, and a missed edge
  degrades to the runtime error rather than to silence. Rejected: the analyzer as sole
  enforcer, argued earlier by a false analogy to `OBSERVED_STATE_NEVER_RUN`, which
  over-approximates — the opposite polarity.
- **Ambient zone state is kernel-owned and normative, not sql-private and not
  annotation-only metadata** — a `use` declaration asserts controller behaviour
  the analyzer cannot check, and annotation-only leaves a wrong `use: call`
  in a third-party schema as silence with no recourse (a consumer-side override was
  rejected: a manifest must not assert a property of a controller it does not own).
  Kernel ownership makes detachment shed zones deterministically at the primitive,
  turning mis-declaration into the runtime error at the right place. The spec binds a
  second runtime's controllers, which one implementation's tests cannot. Rejected:
  sql-private connection-keyed ALS (fixes identity but leaves detachment racing, and
  every future zone-bearing module re-implements the same storage — the `KeyedClaim`
  argument); annotation-only with a normative spec but no mechanism.
- **The stack rides the ambient invocation context; clearing is the default, and the one
  gap it leaves is a stated obligation** — a parallel ambient store would mean
  enumerating every site that must clear it, and one missed site is a false guarantee
  under a hard error. On the existing `InvokeContext` the two clearings the runtime
  already performs — `runDetached` replacing the ambient, a `Telo.Service`'s `run()`
  establishing none — do the work with no zone-specific code, and the residue is exactly
  one shape: an inbound trigger registered from inside an invocation by a non-Service.
  That is spec'd as a conformance obligation on the registrant (dispatch through the
  kernel's root-context entry point), which is what the `trigger.inbound` error severity
  actually rests on. Rejected: clearing at "inbound span openings" — `openSpan` is
  tracing-gated (a pass-through when tracing is off), opt-in, and called by one
  controller, so the guarantee would be off by default and absent for timers; and
  inferring the guarantee from every shipped inbound kind being a Service, which is true
  today and is a property of those kinds rather than of the edge.
- **A zone entry carries typed handles, not instances** — `provider` / `key` as a bare
  instance reference would type nothing, would hand every controller in the process a
  live reference to another module's instance through the ambient stack, and could not
  cross the ABI, making the same contract unimplementable in `kernel/rust`. A
  `ResourceHandle` is compared by a kernel-minted per-instance id and carries the
  declaration label only for diagnostics; the instance → handle map has no reverse
  direction. Per-*instance* rather than per-declaration because two concurrent runs of a
  `with:`-scoped connection are two connections, which is also what the static rule says.
  Rejected: the instance object (untyped, leaky, unportable); `RefIdentity` as the
  identity (collapses those two connections into one); an opaque provider payload on the
  entry (`sql`'s executor lives in a module-private `WeakMap` keyed by the entry, so the
  contract stays three identities and stays serializable).
- **A scope function, not a push/pop pair** — push/pop cannot be honest across async
  boundaries, and the kernel already spells this shape twice (`runDetached`,
  `withManifests`). It hands back both the derived context (threaded into
  `invokeResolved`, the discipline cancellation already has) and the minted entry (what a
  provider with private state keys its own map on).
- **Provider-private zone state hangs off an injected instance, never a module import** —
  a module's controllers ship as separate bundles that each inline their copy of a shared
  source file, so module-scoped state is per-bundle. That is already a live `sql` bug
  (`transaction:` throws on every path because `assertActive()` and the ambient store are
  two `AsyncLocalStorage`s), and a `WeakMap` shared between the transaction controller and
  the connection base would reproduce it — with `?? this.db` converting the miss into
  silent non-transactional execution, worse than the current throw. The map is an instance
  field on the connection, the object both sides hold by reference, and the explicit-zone
  path throws instead of falling back. Normative in the spec, not a `sql` note: every
  zone-bearing module with separately-delivered backends meets this. Rejected: a
  module-global `WeakMap` (the bug, restated); adding `@telorun/sql` to
  `REALM_COLLAPSE_NAMES` (an inlined source file leaves no import to redirect, so
  collapse cannot reach it); putting the payload on `ZoneEntry` (makes another module's
  open transaction readable from any controller, and breaks ABI serializability).
- **A controller names its annotation site, never a kind** — a controller has no alias
  scope: `ctx.moduleContext` is the scope that owns the *resource* (the consumer's
  application), not the module that declared the kind, and `resolveKind` is not on the
  controller surface. So an alias would resolve against the wrong module and a canonical
  `"sql.Transaction"` would hand-copy another module's `metadata.name` into code — the
  annotation/controller disagreement this design exists to prevent, reintroduced in the
  one place nothing checks it. Naming the slot instead makes every field of the entry
  derived: `kind` and `key` from the annotation, `provider` from the owning resource
  (which is also the runtime half of why `zone:` is not authorable on a provider slot).
  The undeclared ambient case — a statement with no `transaction:` joining an open one —
  has no annotation to read, so it goes through `zonesFor(instance)` and lets the
  provider's private map discriminate; still no kind string. Rejected: a kind parameter
  (unwritable correctly from a controller); exposing `resolveKind` on `ResourceContext`
  (it would resolve in the consumer's scope, giving a confidently wrong answer);
  requiring providers to be in the same module as requirers (rules out every
  cross-module zone, which is most of them).
- **The inbound obligation gets a named API rather than only a spec sentence** — an
  explicit context already replaces the ambient at dispatch, so `rootContext()` adds no
  mechanism; what it adds is something the spec can point at, a reviewer can see missing,
  and a conformance test can target. The analyzer's only hard error rests on it.
  Rejected: the rule with no API (unenforceable in review); folding it into
  `createCancellationSource` (a timer-driven trigger needs a root context and no source).
- **Zone behaviour is derived from `use`, never declared separately** — an earlier
  revision carried its own classification enum (`x-telo-dispatch`), a heuristic
  advisory for unclassified slots, a CI gate promoting it, and a mode-dependence
  annotation (`x-telo-zone-breaking`). All four existed to compensate for the untyped
  reference edge, and all four dissolve into the prerequisite: declaring `use` is
  mandatory there, so a *slot* can no longer be unclassified; the case-map and set forms
  carry mode-dependence; and severity is a projection (guaranteed-cleared errs,
  consumer-drained warns). Rejected: keeping a zone-local classification beside `use`
  (two annotations answering one question — the disagreement this pair of plans exists
  to end).
- **Severity follows whether the edge is DECIDABLY wrong, not whether the `use`
  resolved per instance** — an error is claimed wherever the runtime *guarantees* a
  fresh context on some dispatch through the edge: a singleton `detached` /
  `trigger.inbound`, a case map resolving to one, **and a set containing one**. A
  requirement is a universal claim ("I must be reached through a zone"), and the
  detached dispatch is never inside the caller's zone — so the manifest is wrong;
  what stays unknown is only how often that path is taken, and "sometimes throws" is
  not a working manifest. `trigger.consumer` warns because there the unknown is
  genuinely unknowable — a consumer may drain the value *inside* the zone — as do an
  unresolvable selector and an undeclared `use`.
  **This reverses the rule an earlier revision carried** (a set may block propagation
  but never error). That rule existed for exactly one case: `Cache.View`'s
  UNCONDITIONAL `[call, detached]` against a `sync` default, under which nothing
  detaches, so most-severe-member would have hard-errored every working cached
  transactional call. This plan removes that case by re-annotating the slot as a case
  map, so a set now appears only where its detach genuinely happens — the
  justification went with the annotation, and keeping the rule meant
  `revalidate: background` checking clean while throwing `ERR_ZONE_REQUIRED` on every
  stale revalidation. Propagation is unchanged and still needs every member to be
  `call`. Rejected: erroring at every non-call edge (false errors on stream
  consumers); warning everywhere (guts the flagship route diagnostic, which is sound);
  keeping the set warning (silently clean on a manifest that throws in production).
- **An unknown `use` neither propagates nor terminates** — mandatory `use` removes the
  unclassified *slot*, not the unclassified *edge*: a ref found by the value-tree scan
  has no schema behind it by construction, and a case-map selector can be absent or
  unmatched. The graph reads all of these as control-transferring, which is right for
  throws and reachability and backwards for zones, whose polarity is the opposite. So
  they warn. Rejected: adopting the graph's default (invents requirement paths, and
  invents failures at the end of them); silently dropping the requirement (the one state
  where a real error hides, with nothing shown).
- **Type-scoped and connection-correlated, decided against the fixed runtime** — the
  connection-identity fix is sequenced ahead rather than deferred, because deciding
  scoping against the current runtime would anchor a load-bearing decision to a tracked
  data-integrity bug and ship a check that reports clean on the corrupting case.
  Correlation identity is the resolved declaration site — `(declaring file, resource
  name)` for a named module-level resource, the scope site for a `with:`-scoped
  connection, the declaring node for an inline one — mirroring runtime instance identity
  exactly, so the check is
  never stricter or looser than what would execute. The declaring file rather than the
  owning module name, because a re-exported instance is forwarded once per re-exporting
  module under that module's name while its declaration site survives the copy — keying
  on the module would split one connection into several across a re-export chain.
  Rejected: instance scoping (still
  no runtime counterpart after the fix, and it makes a body invocable from exactly one
  place, unfixable across a module boundary); bare type-scoping (silent on a
  cross-connection mistake); a standalone must-be-transactional flag (a parallel field
  on three published kinds for an assertion `transaction:` already carries).
- **The provider names no zone; the requirer names it, and each side declares its own
  key** — a provider `zone:` prop carried no information (every shipped provider
  named itself) and made provision-on-behalf-of expressible, a claim about another
  module's controller. Zone identity is the declaring kind; discharge walks
  `extends`, the acceptance rule `x-telo-ref` slots already have. Correlation is
  declared two-ended: the provider's scalar pointer and the requirer's `key` each name
  a field of their own schema, so an earlier draft's `correlate: connection` — a bare
  word silently meaning "the same-named field on both sides" — is gone along with its
  implicit coupling. The one place a side reads a field it does not declare is a key
  pointer traversing a `!ref`, which is why that is confined to a kind the declaring
  module owns. Rejected: `zone:` on the provider; single-ended correlation; an
  object wrapper around the provider's lone value; unrestricted traversal (an annotation
  depending on a field name in a module its author cannot keep true).
- **`reason:` is optional on the requirer, absent on the provider** — the diagnostics'
  mechanical half (resource, zone, correlation target, path, terminating edge) is
  already concrete, so the completeness argument that makes the durable plan's
  exclusion `reason` mandatory does not transfer; what the author adds is the runtime
  consequence, quoted after the path. Requiring it would kill the bare-string form and
  boilerplate self-evident slots; nothing fails at a provider, so it has nowhere to
  speak.
- **A correlation key is an ordered pointer list, and an unresolved key discharges
  uncorrelated** — the correlated field is *optional* on all three shipped requirers
  and the idiomatic manifest omits it, deriving the connection from the transaction it
  names, so a single pointer would leave correlation undefined in the common shape.
  The list transcribes the controller's own `??` (`key: [/connection,
  /transaction/connection]`), with pointers allowed to traverse a `!ref` into a kind the
  declaring module owns — mechanical, so the analyzer still names no kind, and authored
  by the module that owns the derivation. When nothing resolves, no correlation is
  asserted: inventing one would manufacture errors from a guess, against the plan's
  under-approximating polarity.
  Rejected: a single pointer (undefined in the common shape); hardcoding the
  `transaction:` derivation in the analyzer (kind knowledge the topology constraint
  forbids); diagnosing an absent key (punishes the idiomatic manifest).
- **Export requirements are derived per library in their own analysis stage, cached by
  library** — the flattened view the diagnostic passes see carries the export surface,
  not the internal dispatch chain, so the projection cannot run over it; it runs over the
  full documents the loader still holds. But not *at* flatten: flatten is manifest
  selection, and the registry and alias resolvers the projection needs are built from its
  output, so running a call graph there inverts the staging and puts a library's
  diagnostic inside the importer's selection step. It is a stage in `analyze()` instead,
  after registries exist. The cache is a **host-lifetime parameter**, keyed
  `(source identity, content signature)`: `AnalysisRegistry` is constructed fresh per
  closure per run by the editor, so a cache there would die at the boundary it exists to
  cross, and identity alone is stale-unsafe for a workspace library whose documents change
  between runs. It is a requirement rather than an optimization — the editor re-analyzes
  on every keystroke, and a per-run memo rebuilds every dependency's graph each time.
  Rejected: `AnalysisRegistry` as the home (wrong lifetime); identity-only keys (serves a
  stale contract for the libraries the user is editing); editor-owned invalidation on
  document change (a second correctness rule to keep in sync, where the signature makes
  staleness unrepresentable). An export whose requirement correlates on an unreachable internal resource
  errors at the library, not the importer — the only desk where it is fixable, and the
  importer derives the same set without reporting it. The deliberate consequence stands:
  a library edit adding a requirement inside an exported resource moves that export's
  contract, and this stage is where that becomes visible. Rejected: deriving at flatten
  (inverted staging, plus a rebuild per keystroke); a **declared** open-requirement list
  on the library's export surface, verified against derivation (it makes an author
  hand-write derived facts, and needs a new export syntax for something no one authors —
  `exports.kinds` is declared because it is intent, and this is not).
- **Shared graph, separate analysis from `throws:`** — one edge discovery (the
  prerequisite's service), two projections: opposite polarity, different discharge
  sites. Rejected: modelling a zone as an effect on the `throws:` axis; sharing the
  traversal state between the two analyses (their memoization keys differ — a throws
  union is per resource, a zone walk is per requirement).
- **Requirements are resolvable kind names, never author-written strings** — an
  unvalidated label on a safety-relevant constraint fails silently, unlike
  `metadata.categories` where a typo is harmless.
- **Provide/require only; exclusion omitted** — a body forbidding an effect defined
  elsewhere inverts the dependency direction, and cannot be expressed as a requirement:
  an enclosing durable zone legitimately satisfies a suspension requirement while
  parking there is still wrong. Exclusion annotations live in the durable-execution
  plan.
- **No check for an unbound resource inside a zone** — an unbound statement inside a
  transaction body *does* join it, so such a check would reject correct manifests and
  break importer-wrapped library sequences.
- **Portable by construction, Node-first in practice** — the annotations are schema
  data, the severity rule presumes no runtime, and the zone-state contract is spec'd
  rather than implementation-defined. The Rust kernel implements the spec when its
  scope grows; `analyzer/rust/` emits no diagnostics at all yet, so `telo check` parity
  stays a pre-existing non-goal (`resolve_zone_requirements.rs` when it lands).
- **The value is earlier failure plus deterministic runtime semantics** — the
  annotations move an existing runtime error to check time for statically visible
  paths; the kernel-owned state fixes the cross-connection execution, the
  cross-connection nesting and the detach race as part of the prerequisite. The two
  remaining `sql` gaps above are untouched.

## Complete example after the change

The definitions carry the annotations; the wiring manifests are unchanged Telo. First
the annotated slots, as excerpts of the shipped definitions (already in the
typed-reference form):

```yaml
# modules/sql/telo.yaml (excerpt)
kind: Telo.Definition
metadata:
  name: Transaction
capability: Telo.Invocable
schema:
  type: object
  required: [connection, steps]
  properties:
    connection:
      x-telo-ref:
        kind: Self.Connection
        use: dependency
    steps:
      description: Resource executed inside the transaction.
      x-telo-ref:
        # Widened from Telo.Invocable — a Run.Sequence body is the whole point,
        # and the direct-statement shape the old constraint allowed cycles.
        kind: Telo.Executable
        use: call # the controller awaits the body inline…
      x-telo-provides-zone: /connection # …inside this kind's zone, keyed by its connection
---
# modules/sql/telo.yaml (excerpt)
kind: Telo.Definition
metadata:
  name: Command
capability: Telo.Invocable
schema:
  type: object
  properties:
    connection:
      x-telo-ref:
        kind: Self.Connection
        use: dependency
    transaction:
      description: Reference to the SQL transaction resource.
      x-telo-ref:
        kind: Self.Transaction
        use: dependency # not a call — what this slot carries is the requirement:
      x-telo-requires-zone: # reach me through a Transaction zone on my connection
        zone: Self.Transaction
        # connection: is optional here — when omitted the controller derives it
        # from the transaction, so the key tries both, in that order.
        key: [/connection, /transaction/connection]
        reason: the statement would execute outside any transaction
```

Then the manifest an application author writes — no annotation in sight:

```yaml
kind: Sql.Transaction
metadata:
  name: accountTx
connection: !ref appDb
steps: !ref accountWrites
---
kind: Run.Sequence
metadata:
  name: accountWrites
steps:
  - name: insertAccount
    invoke: !ref insertAccount
    inputs:
      email: !cel "inputs.email"
---
kind: Sql.Command
metadata:
  name: insertAccount
connection: !ref appDb
transaction: !ref accountTx
sql: INSERT INTO accounts (email) VALUES ($1) RETURNING id
```

`insertAccount` declares a `transaction:`, so it requires a transaction zone correlated
on `appDb`. The requirement travels up two `call` edges — `accountWrites`' step slot and
`Sql.Transaction.steps` — and `accountTx`
discharges it, since `steps` also provides the zone and its `connection:` is the same
`appDb`.

Wire `accountWrites` to an HTTP route instead and the requirement reaches
`Http.Api.routes[].handler`, a `trigger.inbound` edge: `ZONE_REQUIREMENT_UNSATISFIED`,
naming
the route, the path, and the zone wanted — where today that route throws only when it is
first exercised. Put it in a root Application's `targets:` and the same fires at boot.
Point `accountTx` at a different connection and the correlation fails — correctly, since
under the fixed runtime the statement would not be transactional there.

A statement declaring no `transaction:` requires nothing and is checked nowhere —
including inside a transaction body, which it joins ambiently, exactly as today. That is
also the shape a library exports: its writes make no assertion, so an importer wrapping
them needs no declaration on either side.

## What a module author writes in the controller

The annotation is the static face of a runtime declaration, so a zone-bearing kind is
always two halves that must agree. Below is each half as the author writes it.

### Providing a zone

The kind that *declares* the zone is the one that opens it, naming its own annotated slot.
The executor map is an **instance field on the connection** — the object both controllers
hold by reference — because a module-scoped map would be one map per controller bundle
(the payload rule above):

```ts
// modules/sql/nodejs/src/sql-connection-base.ts
/** Executors for zones open on THIS connection. An instance field, not a module
 *  global: the transaction controller and this base are different bundles. */
readonly #executors = new WeakMap<ZoneEntry, Kysely<any>>();

/** Open a transaction and let the caller bind it to the zone entry it mints. */
async runInTransaction<T>(body: (bind: (entry: ZoneEntry) => void) => Promise<T>): Promise<T> {
  return this.db.transaction().execute((trx) =>
    body((entry) => this.#executors.set(entry, trx)),
  );
}
```

```ts
// modules/sql/nodejs/src/sql-transaction-controller.ts
async invoke(inputs: unknown, ctx?: InvokeContext): Promise<unknown> {
  return this.connection.runInTransaction((bind) =>
    // "steps" is this kind's own slot; the kernel reads `x-telo-provides-zone`
    // there for the kind (itself) and the correlation key (`/connection`).
    this.ctx.withZone("steps", (zoneCtx, entry) => {
      bind(entry); // hands the entry to the connection's own map — across the bundle split
      return this.ctx.invokeResolved(this.stepsKind, this.stepsName, this.steps, inputs, zoneCtx);
    }),
  );
}
```

`withZone` hands the derived context back so it can be threaded into the body dispatch —
the same place cancellation is already threaded — and the entry so the executor has
something to hang on.

### Requiring a zone

A statement that declares `transaction:` names that field, and the kernel supplies both
the zone kind and the correlation key from the annotation — including the
`[/connection, /transaction/connection]` fallback, so the idiomatic statement that omits
`connection:` correlates the same way the controller's own `??` would:

```ts
// modules/sql/nodejs/src/sql-command-controller.ts
async invoke(inputs: unknown, ctx?: InvokeContext): Promise<unknown> {
  // ERR_ZONE_REQUIRED when no sql.Transaction is open on THIS statement's
  // connection — which is the behaviour fix: a transaction on another connection
  // no longer answers. Replaces `transaction.assertActive()`, which could only
  // say *some* transaction was open.
  const zone = this.transaction ? this.ctx.requireZone("transaction") : undefined;
  return this.connection.execute(this.sql, params, zone);
}
```

The **undeclared** case still has to work — a statement with no `transaction:` joins an
open one ambiently, and no annotation describes that — so the connection asks for zones
correlated on itself and lets its own map do the filtering:

```ts
// modules/sql/nodejs/src/sql-connection-base.ts
private resolveExecutor(zone?: ZoneEntry): Kysely<any> {
  const entry = zone ?? this.ctx.zonesFor(this).find((e) => this.#executors.has(e));
  if (zone && !this.#executors.has(zone)) {
    // A zone this connection did not open cannot be silently ignored: the caller
    // declared a requirement, and `?? this.db` here would execute it outside the
    // transaction it asked for. The one place the fallback must not apply.
    throw new InvokeError("ERR_SQL_ZONE_FOREIGN", `…`);
  }
  return (entry && this.#executors.get(entry)) ?? this.db;
}
```

No kind string appears anywhere in either half: the declared path resolves through the
annotation, and the ambient path discriminates by whether this connection opened the zone.
The explicit-zone branch throws rather than falling back, so a future delivery split
resurfaces as a loud failure instead of silent non-transactional writes.

### Registering an inbound trigger

An inbound registrant dispatches with a context it minted, never `undefined` — which is
what makes the handler's zone stack empty regardless of what was ambient when the trigger
was registered. `Http.Api` already does this via its per-request cancellation source; the
change is that the obligation now has a name and a spec line:

```ts
// modules/http-server/nodejs/src/http-api-controller.ts
const cancellation = this.ctx.createCancellationSource();
const span = await this.ctx.openSpan(this.ctx.rootContext({ cancellation }), { … });
await this.ctx.invokeResolved(handlerKind, handlerName, handler, invokeInput, span.context);
```

A timer-driven kind that is *not* a Service — the shape nothing structural covers — reads
identically:

```ts
setTimeout(() => {
  void this.ctx.invokeResolved(kind, name, target, inputs, this.ctx.rootContext());
}, delayMs);
```

### A new zone-bearing kind, both halves

A third-party module declares the pair the same way the standard library does — schema
annotations for the analyzer, `withZone` / `requireZone` for the runtime. An
**uncorrelated** zone (no `key` on either side) is the simpler shape, and is what a kind
with a single ambient resource per process wants:

```yaml
# telo.yaml
kind: Telo.Definition
metadata:
  name: Batch
capability: Telo.Invocable
schema:
  properties:
    steps:
      x-telo-ref: { kind: Telo.Invocable, use: call }
      x-telo-provides-zone: true # uncorrelated — the zone is the kind, no payload
---
kind: Telo.Definition
metadata:
  name: Enqueue
capability: Telo.Invocable
schema:
  properties:
    batch:
      x-telo-ref: { kind: Self.Batch, use: dependency }
      x-telo-requires-zone:
        zone: Self.Batch
        reason: the message would be written outside any batch, losing atomicity
```

```ts
// batch-controller.ts — provider names its own annotated slot
return this.ctx.withZone("steps", (zoneCtx, entry) => {
  pending.set(entry, []);
  return this.ctx.invokeResolved(k, n, this.steps, inputs, zoneCtx);
});

// enqueue-controller.ts — requirer names its own annotated field
const zone = this.ctx.requireZone("batch");
pending.get(zone)!.push(message);
```

Note what neither controller writes: the module's own name, the other kind's name, or an
alias. `"steps"` and `"batch"` are fields of the schema sitting right beside the code, and
everything else — which kind the zone is, what it correlates on, which resource provides
it — comes from the annotation. Nothing else changes for the author: `use: call` on the
body slot is what the enqueue's requirement travels along, and `telo check` reports an
`Outbox.Enqueue` wired to a route without a `Batch` above it before the route is ever
exercised.

## Examples that fail static analysis

One per diagnostic.

### `ZONE_REQUIREMENT_UNSATISFIED`

A bound statement wired straight to a route. `insertAccount` requires a transaction
zone correlated on `appDb`; the requirement travels up through the route's `handler:`
slot — a `trigger.inbound` edge, guaranteed cleared — and nothing on the way provides
it:

```yaml
kind: Http.Api
metadata:
  name: accountsApi
routes:
  - request: { path: /accounts, method: POST }
    handler: !ref insertAccount
---
kind: Sql.Command
metadata:
  name: insertAccount
connection: !ref appDb
transaction: !ref accountTx
sql: INSERT INTO accounts (email) VALUES ($1) RETURNING id
```

The error names the route, the propagation path, and the wanted zone — where today
this throws `assertActive()` only when the route is first exercised. The same diagnostic
fires on a correlation failure: wrap the statement in a transaction whose `connection:`
is a *different* connection and the requirement passes the provider undischarged,
because under the fixed runtime that statement would not be transactional there.

### `ZONE_REQUIREMENT_DEFERRED` (warning)

The same bound statement registered as a stream-completion handler.
`OnComplete.handler` is a `trigger.consumer` edge — the handler runs when whoever holds
the returned stream drains it, and a consumer draining inside a transaction genuinely is
inside it:

```yaml
kind: RecordStream.OnComplete
metadata:
  name: auditOnDone
handler: !ref insertAccount
```

No guarantee holds in either direction, so this warns with the full path instead of
erroring — a hard error here would reject a manifest that works — and the runtime
assertion remains the enforcement at the drain site.

The same warning, with a different sentence naming why, covers the other two undecidable
edges: a `use` set that cannot be narrowed per instance, and an edge with no usable `use`
at all (a value-tree-discovered `!ref`, or a case-map selector that is absent or matches
no case). Wire the same statement through a `Cache.View`, though, and there is **no**
diagnostic under the default `revalidate: sync` — its case map resolves that instance's
slot to a plain `call`, so the requirement travels through and the enclosing transaction
discharges it; only `background` produces the warning.

### `ZONE_EXPORT_UNSATISFIABLE`

A library exports a sequence whose requirement correlates on a connection it does not
export:

```yaml
kind: Telo.Library
metadata:
  name: Billing
imports:
  Sql: ../sql
  Sqlite: ../sql-sqlite
exports:
  resources:
    - billingWrites # billingDb and billingTx stay internal
---
kind: Sqlite.Connection
metadata:
  name: billingDb
file: ./billing.db
---
kind: Sql.Transaction
metadata:
  name: billingTx
connection: !ref billingDb
steps: !ref billingWrites
---
kind: Run.Sequence
metadata:
  name: billingWrites
steps:
  - name: charge
    invoke: !ref charge
    inputs:
      account: !cel "inputs.account"
---
kind: Sql.Command
metadata:
  name: charge
connection: !ref billingDb
transaction: !ref billingTx
sql: UPDATE accounts SET balance = balance - $1 WHERE id = $2
```

Reached through `billingTx` the requirement is satisfied, but the *export* of
`billingWrites` carries it open — a contract importers must satisfy — and it correlates
on `billingDb`, which no importer can reference. Unsatisfiable by construction, so it
errors at the library's own check, the one desk where it is fixable: export `billingDb`
too (importers wrap the sequence in their own transaction on it), or export a runnable
that goes through `billingTx` instead of the raw sequence.

### `ZONE_PROVIDER_UNRESOLVED`

A requirement annotation naming a provider kind that does not resolve — here a typo:

```yaml
kind: Telo.Definition
metadata:
  name: AuditedCommand
capability: Telo.Invocable
extends: Sql.Command
schema:
  type: object
  properties:
    transaction:
      x-telo-ref:
        kind: Sql.Transaction
        use: dependency
      x-telo-requires-zone:
        zone: Sql.Transation # typo — no such kind
        key: [/connection, /transaction/connection]
```

The zone name resolves through the same alias-qualified grammar as `extends` and
`x-telo-ref`, so `Sql.Transation` — or an alias not declared in this file's `imports:` —
is a hard resolution failure at the declaring module, mirroring `X_TELO_REF_UNRESOLVED`.
Without it, the misspelling would leave the constraint silently unenforced: no provider
ever matches a kind that does not exist, so every requirement it expresses would simply
never fire.
