# Execution zones

**Depends on `plans/typed-reference-graph.md`.** That plan supplies the typed call
graph — every ref slot's `use`, the shared graph service, the step model — and this
plan is its first consumer: zone semantics evaluated over edges something else
discovers. Everything this plan once carried about *classifying* slots
(`x-telo-dispatch`, the unclassified advisory, its CI gate, `x-telo-zone-breaking`,
the manifest × schema walk) now lives there.

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
  payload and the requirer's own resolved key must be the same resource (below) — each
  side reads only its own document, so nothing
  couples on a field name the other side is merely hoped to share. The optional
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
- **`detached`** and **`trigger.inbound`** — the runtime *guarantees* the zone stack is
  cleared (the kernel's detach primitive; an inbound span opening). A requirement
  arriving at such an edge provably cannot be satisfied: **error**,
  `ZONE_REQUIREMENT_UNSATISFIED`, carrying the path.
- **`trigger.consumer`** — no guarantee either way: whoever drains the returned value
  decides where the dispatch runs, so a consumer draining inside a transaction genuinely
  is inside it. A requirement arriving here is `ZONE_REQUIREMENT_DEFERRED`, a
  **warning** with the same information, and the runtime assertion stays the real
  enforcement.
- **`dependency`** and **`schema`** — no edge; requirements neither enter nor leave.
  `Sql.Query.transaction` is exactly this: a dependency ref that *carries* the
  requirement without being a call.
- A **`use` set** propagates only if every member is `call`; otherwise it takes the most
  severe non-call member (`Cache.View`'s `[call, detached]` is an error edge — under
  `background` some dispatches detach, and a requirement satisfied on only some paths is
  not satisfied). A **conditional `use`** resolves per manifest before zones ever look —
  the selector is statically resolvable by the typed-ref plan's rule — so a
  `Lease.Critical` instance is a `call` or `detached` edge according to its own
  `detach:`.
- **Boot is the root**: nothing encloses an Application's `targets:`, so an open
  requirement surfacing at a boot entry errors there.

**The runtime half: ambient zone state is kernel-owned.** What `sql` implements
privately today — a module-global `AsyncLocalStorage` of open transactions — becomes a
kernel facility: an ambient zone stack carried the way the cancellation scope already
is. A providing controller pushes and pops an entry (provider kind, instance identity,
optional correlation payload) through an SDK call — the schema annotation is the static
face of that same declaration; `ctx.runDetached` and inbound span openings **clear** the
stack, which only the kernel can do because it owns those primitives; a requiring
controller consults it — `assertActive()` reads the kernel stack keyed by connection
instead of `txStorage`. This is what gives declared edges teeth. A composer that
detaches through the kernel primitive sheds the enclosing zone *deterministically*, so
a wrong `use: call` in a schema the consumer cannot edit degrades to the
existing runtime error at the right place — instead of the timing-dependent silence
`txStorage` allows today. The contract is normative in
`kernel/specs/execution-zones.md` (the invocation-contract precedent): it
binds every controller of a kind including a second language's — `console` and
`starlark` already ship dual Node/Rust controllers — and a manifest-facing promise
enforced only by one implementation's tests is not a contract. Residue, stated: work
fired outside the kernel's primitives (a bare floating promise) still inherits whatever
the platform propagates — but such work is already outside detached-task tracking and
teardown draining, a pre-existing contract violation rather than a new hole.

**Prerequisite: the `sql` connection-identity fix lands first, implemented on that
kernel state.** Today `resolveExecutor` reads the global ambient transaction id with no
connection check, so a statement declared on connection B inside connection A's
transaction executes on **A's** connection, and `assertActive()` asserts only that
*some* transaction is open. Flat nesting has the same hole: a `Sql.Transaction` nested
inside another's body reuses the ambient transaction whatever its connection, so a
nested transaction on connection B inside A's never opens a B transaction at all. As
the preceding change, `Sql.Transaction` pushes a zone
entry carrying its connection's identity, and both `resolveExecutor` and
`assertActive()` consult the stack *per connection* — retiring `txStorage`/`txMap`;
nesting flattens only into a same-connection ambient transaction, and a different
connection opens its own. Three
listed defects fall out at once: the cross-connection execution, the cross-connection
nesting, and the detach race —
a detached dispatch sheds the zone at the kernel primitive, so a statement inside it
deterministically sees no transaction instead of racing the commit for a dying
executor. Sequencing this first is what lets scoping be decided against the intended
semantics: a type-scoped check over today's runtime would report **clean** on exactly
the corrupting case, which reads as confirmation of the wiring.

**Requirements are type-scoped and connection-correlated.** An enclosing zone
discharges a statement's requirement when its declaring kind is, or `extends`, the
required kind — the Liskov acceptance `x-telo-ref` slots already have — *provided the
correlation holds*: the zone's correlation payload (the provider kind's `key` field)
and the requirer's `key` field must resolve to the same resource.
Checkable, because both sides are static refs — and it is the static counterpart of the
runtime fix, under which a statement inside a transaction on a different connection is
simply not transactional. **Correlation identity is the connection's resolved
declaration site**, which mirrors runtime instance identity exactly — and it is the
node identity the typed graph already keys on. For a named
module-level resource that spells `(owning module ref, resource name)` — the identity
re-export resolution already collapses alias paths to, so the same connection reached
under different aliases compares equal across module boundaries. A `with:`-scoped
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
owns the controller. When **no** pointer resolves, the requirement discharges
uncorrelated — any zone of the right type satisfies it — the under-approximating side
the whole check leans on, since inventing a correlation the manifest does not state
would manufacture errors from a guess.

**A slot may be both terminating and providing** (`Durable.Run.invoke`, a `detached`
provider): incoming requirements fail there, except the zone it provides.

**An open requirement crosses a library boundary as a contract, derived per library at
flatten time, then stamped.** A `Telo.Library` cannot see its importers, so an exported
resource with an open requirement is a contract for them to satisfy. But the stamp is
not a copy of a declared list the way `stampExportedKinds`'s input is: open requirements
must be *derived* by running the zone projection over the library's internal graph — and
the flattened analysis view no longer holds that graph, because
`selectModuleManifestsForAnalysis` forwards an importer just the export surface
(definitions, abstracts, imports, `exports.resources` instances), never the internal
dispatch chain. The pruning happens at flatten, though, not at load: the importer's own
loader still holds every imported library's full documents. So the projection runs per
library at flatten time, over the full documents, and stamps the derived set onto the
export surface beside `stampExportedKinds`; the importer's diagnostic passes read the
attached set. Memoized per library within an analysis run. There is no cross-run cache
to ride — the existing analysis stamp (`analysis-stamp.ts`) is a single whole-graph
signature per entry and carries no payload — so cross-run memoization would need its
own per-library key (the library's file hashes) and is a later optimization, never a
correctness requirement. An exported resource whose requirement correlates on a resource
importers cannot reach — a library-internal, unexported connection — is unsatisfiable
from outside by construction, and is reported at the *library's* check
(`ZONE_EXPORT_UNSATISFIABLE`), the desk of the one author who can fix it, rather than
left open as a contract no importer can meet.

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

- **Kernel + SDK** (the sequenced prerequisite): the ambient zone stack on the
  invocation context; SDK push/pop for providing controllers and a consult call for
  requiring ones; clearing wired into `ctx.runDetached` and inbound span openings;
  `modules/sql` moved onto it (`txStorage`/`txMap` retired, `resolveExecutor` and
  `assertActive()` connection-keyed). Normative contract in
  `kernel/specs/execution-zones.md`.
- **Analyzer**: `resolve-zone-requirements.ts` — a **consumer of the call-graph
  service**, no traversal of its own: it filters the graph's edges by `use`, propagates
  requirements along `call` edges with memoization and cycle short-circuit, discharges
  at providing slots under the correlation rule, and fires at terminating edges and at
  boot. Export-requirement stamping beside `stampExportedKinds`
  (`flatten-for-analyzer.ts`). Diagnostics:
  `ZONE_REQUIREMENT_UNSATISFIED` (error, with the path and zone),
  `ZONE_REQUIREMENT_DEFERRED` (warning, same information at a `trigger.consumer` edge),
  `ZONE_EXPORT_UNSATISFIABLE` (error, at the exporting library),
  `ZONE_PROVIDER_UNRESOLVED` (mirroring `X_TELO_REF_UNRESOLVED`; also raised when a
  correlation `key`'s every pointer names no property of the declaring schema).
- **Annotated kinds** — only providers and requirers; every slot's `use` is the
  prerequisite plan's migration, not this one's. Providing: `Sql.Transaction.steps`
  (`x-telo-provides-zone: /connection`). Requiring (`zone: Self.Transaction`,
  `key: [/connection, /transaction/connection]`): `Sql.Query.transaction`,
  `Sql.Command.transaction`, `Sql.Selection.transaction`. The durable plan adds
  `Durable.Run.invoke` (providing, on a `detached` edge) and `Durable.Sleep` /
  `Durable.Await` (requiring).
- **Tests**: kernel tests for the zone stack (push/pop, cleared at detach, cleared at
  an inbound span, connection-keyed consult); manifest tests
  for satisfied, unsatisfied-at-a-route, unsatisfied-at-boot,
  reused-across-two-transactions, cross-connection correlation failure,
  open-across-an-import, a requirement on a `with:`-scoped statement satisfied
  inside its scope, an inline-connection correlation failure, a statement omitting
  `connection:` correlating through `/transaction/connection` (and a mismatch on that
  derived path failing), a requirement reaching a `trigger.consumer` edge producing the
  warning and **not** the error, a `Lease.Critical` requirement path in both `detach:`
  modes, and a requirement propagating out of a step nested three levels deep (`try`
  inside `catch` inside a step) — the zone-side check that the graph's step descent
  feeds this consumer. Analyzer unit tests for propagation cycles, memoization, and
  terminating-plus-providing on one slot.
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
- **Zone behaviour is derived from `use`, never declared separately** — an earlier
  revision carried its own classification enum (`x-telo-dispatch`), a heuristic
  advisory for unclassified slots, a CI gate promoting it, and a mode-dependence
  annotation (`x-telo-zone-breaking`). All four existed to compensate for the untyped
  reference edge, and all four dissolve into the prerequisite: `use` is mandatory
  there, so the unclassified state is unrepresentable; the case-map and set forms carry
  mode-dependence; and severity is a projection (guaranteed-cleared errs,
  consumer-drained warns). Rejected: keeping a zone-local classification beside `use`
  (two annotations answering one question — the disagreement this pair of plans exists
  to end).
- **Severity follows the edge's guarantee** — an error is claimed only where the
  runtime *guarantees* clearing (`detached`, `trigger.inbound`); `trigger.consumer`
  warns because the drain site decides, and a hard error there would fire on working
  manifests from a published schema no consumer can edit. A `use` set propagates only
  when pure `call`, else takes its most severe non-call member — a requirement
  satisfied on only some dispatch paths is not satisfied. Rejected: erroring at every
  non-call edge (false errors on stream consumers); warning everywhere (guts the
  flagship route diagnostic, which is sound).
- **Type-scoped and connection-correlated, decided against the fixed runtime** — the
  connection-identity fix is sequenced ahead rather than deferred, because deciding
  scoping against the current runtime would anchor a load-bearing decision to a tracked
  data-integrity bug and ship a check that reports clean on the corrupting case.
  Correlation identity is the resolved declaration site — `(owning module ref, resource
  name)` for a named module-level resource (the identity re-export resolution already
  collapses aliases to), the scope site for a `with:`-scoped connection, the declaring
  node for an inline one — mirroring runtime instance identity exactly, so the check is
  never stricter or looser than what would execute. Rejected: instance scoping (still
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
  implicit coupling. Rejected: `zone:` on the provider; single-ended correlation; an
  object wrapper around the provider's lone value.
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
  /transaction/connection]`), with pointers allowed to traverse a `!ref` — mechanical,
  so the analyzer still names no kind, and authored by the module that owns the
  derivation. When nothing resolves, no correlation is asserted: inventing one would
  manufacture errors from a guess, against the plan's under-approximating polarity.
  Rejected: a single pointer (undefined in the common shape); hardcoding the
  `transaction:` derivation in the analyzer (kind knowledge the topology constraint
  forbids); diagnosing an absent key (punishes the idiomatic manifest).
- **Export requirements are derived per library at flatten time, then stamped** — the
  flattened view the diagnostic passes see carries the export surface, not the internal
  dispatch chain, so the projection cannot run there; it runs where the full documents
  are still in hand (the loader holds them; `selectModuleManifestsForAnalysis` prunes
  at flatten), once per library per analysis run, stamping the set beside
  `stampExportedKinds`. Cross-run memoization cannot ride the existing analysis stamp —
  one whole-graph, payload-less signature per entry — so it stays a later optimization
  under a per-library key, never a correctness requirement. An
  export whose requirement correlates on an unreachable internal resource errors at the
  library, not the importer — the only desk where it is fixable. The deliberate
  consequence stands: a library edit adding a requirement inside an exported resource
  moves that export's contract, and the stamp is where that becomes visible.
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
      description: Invocable resource executed inside the transaction.
      x-telo-ref:
        kind: Telo.Invocable
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
