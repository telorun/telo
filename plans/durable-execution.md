# Durable execution

**Builds on execution zones**, which have landed: the provide/require annotations,
the ambient zone stack on `InvokeContext`, and the satisfaction walk are in place
(`kernel/specs/execution-zones.md`). This plan adds the replay machinery and the
narrow seam that keeps it from forking across backends, the *containment* walk the
satisfaction walk is the mirror of, and the registered zone attributes a zone uses to
forbid what a requirement cannot express.

## Problem

A manifest that orchestrates real work — charge a card, provision an account, wait
for an approval, retry a flaky upstream — must survive process death. Today it
cannot. A `Run.Sequence` holds its entire state in memory: the `steps` accumulator
threaded through `StepEngine.executeSteps`. A crash loses it, and a restart either
re-runs every effect or none.

The pieces are almost all present. `Idempotency.Once` gives durable at-most-once
execution with result replay, over `KvStore.Store` and `KeyedClaim`. The kernel has
a single traced dispatch chokepoint (`EvaluationContext.runInvoke`) and already
propagates ambient invocation context through it via an `AsyncLocalStorage`, for
exactly the stated reason that composing controllers must not thread it by hand.
The CEL catalog already carries a `deterministic` flag per function. What is
missing is the three things a per-call decorator structurally cannot supply:
**run identity**, **a replay driver**, and **suspension**.

The `workflow` / `workflow-temporal` modules were the earlier answer and are the
wrong one. `workflow` was never implemented (its README says so). Its gateway-node
control flow duplicates a step grammar `run` already owns and won. Its per-node
`options`, schema-derived from the backend, makes the manifest engine-specific in
the one dimension Telo keeps neutral. And by delegating execution wholesale it
leaves Telo with no durability of its own on a plain Postgres. Both are removed. The
per-engine modules below are not a return to that: an engine module owns *when a run
advances*, never the step grammar — which is exactly the dimension `workflow-temporal`
gave away.

## Solution

Durable execution is **journal plus deterministic replay**, and Telo can have it
cheaply because of a property that fell out of `Run.Sequence`'s design: a run's
entire mutable state is the `steps` map, and control flow is re-derived from pure
CEL over it. So replay is re-running the step list while returning recorded
results instead of dispatching. No continuation capture.

**The shared thing is a narrow replay seam, not a portable engine vocabulary.** The
temptation is to abstract durable execution itself — one `Durable.*` surface every
backend implements. That is what `workflow-temporal` was, and it fails the same way
twice: the abstraction becomes the union of every engine's lifecycle model
(identity policy, schedule overlap rules, cancel-versus-terminate, deployment
pinning), and each backend still loses the half of its own model that did not
generalize. Portability is the stated payoff, and it is close to worthless — in-flight
runs do not migrate between engines, the configuration shares nothing, and nobody
switches durable execution engines twice.

**The real constraint is that `Run.Sequence` must not fork.** The step engine, the
journaling rule, and every static check over them are Telo-level machinery, and a
backend that goes fully its own way must either re-implement them, or define its own
step grammar — which is precisely the engine-specificity this plan deletes. That, and
only that, is what needs a seam. So the seam is sized to it:

- **Shared** — the run-handle interface (`@telorun/sdk`), the `durable` member on
  `InvokeContext` and the suspension signal (kernel), the replay-determinism contract
  and key scheme (spec), and four kinds in `modules/durable`.
- **Native** — everything else. Each backend ships its own module in its own
  vocabulary and exposes its full model, with nothing flattened to a common
  denominator.

**`modules/durable` is four kinds and no operations.**

- **`Durable.Run`** — a **`Telo.Abstract` marker**. It declares no schema, no
  controller and no contract; a backend's workflow kind `extends` it. Its entire job
  is to give the parking kinds one zone kind to require, after which the landed
  Liskov acceptance (*an entry satisfies a requirement when its kind is, or
  transitively extends, the required kind*) makes `Restate.Workflow` and
  `Temporal.Workflow` satisfy it for free.
- **`Durable.Sleep`** — park until a time.
- **`Durable.Await`** — park until a token resolves, returning a backend-minted token.
- **`Durable.Value`** — journal one impure evaluation.

The three parking kinds are shared because they talk to nothing but the ambient run
handle. Everything with an opinion about *identity, scheduling, delivery or
cancellation* is backend-native, because that is where the engines actually differ and
flattening the differences costs fidelity in both directions.

### What each backend owns

A backend module ships whatever its engine really has, named as its engine names it:

- **`modules/durable-local`** — `Workflow` (extends `Durable.Run`; holds the body,
  provides the zone, owns run identity), `Journal` (an abstract: first-writer-wins
  append, ordered read, run record, due-runs query), `Resumer` (the polling
  `Telo.Service`), `Deliver`, `Status`, `Result`, `Cancel`, `Schedule`, `Resume`.
  `durable-journal-sql` over `Sql.Connection` and `durable-journal-memory` extend the
  journal — the `cache`/`cache-redis` shape, one level down from where it used to sit.
- **`modules/restate`** — `Workflow` (registered as a Restate *workflow*, so the run
  id is a virtual-object key), `Endpoint` (the `Telo.Mount` Restate invokes),
  `Awakeable`, `VirtualObject` **with its state**, `Schedule`, `Cancel`.
- **`modules/temporal`** — `Workflow`, `Worker` (the polling `Telo.Service`), `Signal`,
  `Update`, `Query`, `Schedule`, `Cancel`, `SearchAttribute`.

**`durable-local` is a peer, not the reference implementation.** It has no engine to be
native to, so its kinds look like the old generic ones — but it is one backend among
three, and its journal, its resumer and its manifest digest are its own mechanisms, not
obligations on anyone else.

**The static checks do not care.** They are topology-driven and key off the
`x-telo-provides-zone` annotation, never off a kind — so `DURABLE_NONDETERMINISM`,
`Telo.noSuspend` containment, `requireCheckpoints`, the `outputType` requirement and
atomic-zone collapse all apply unchanged to `Restate.Workflow` and `Temporal.Workflow`
without the analyzer knowing either exists. This is what makes native backends
affordable: going native costs a module, not an analyzer change.

**The kernel is a pure conduit** — it carries the run handle and never calls it, so it
needs no contract of its own. `kernel/specs/durable-execution.md` therefore covers
only the kernel's half: handle propagation on `InvokeContext`, the suspension signal
and what must not swallow it, hold release. The step engine consumes the handle
through a TypeScript interface in `@telorun/sdk` — the split logging already makes
between `Logger` / `RecordBuffer` and the `Telo.LogSink` abstract.

**The run handle is three methods**: *have you a recorded result at this key*, *record
this one*, *park until*. Under `durable-local` those land in a `DurableLocal.Journal`;
under a hosted engine they are protocol frames on the open invocation. The step engine
cannot tell, and that is the entire extent of what the backends share.

**The handle must be reachable from nested dispatches; how is the runtime's choice.**
That is the normative statement — the Node kernel satisfies it by putting the run
handle and current step path on `InvokeContext`, beside `zones`, and letting the
existing `AsyncLocalStorage` carry them; `deriveContext` propagates them like every
other member, so no rebuild site opts in. A runtime with no ambient mechanism (the
Rust kernel's `invoke_dispatch` is synchronous and takes no context) threads it
explicitly. The spec constrains reachability, never the mechanism.

**It is a member of its own, not a zone-entry payload.** The durable zone is a real
zone and rides the landed stack, but a `ZoneEntry` is three identities and nothing
else — provider kind, provider handle, correlation handle — *because* that keeps an
entry ABI-serializable and stops any controller reading another module's open state
off the stack. A run handle is a live object with methods; hanging it on the
entry would trade that property away for every zone, durable or not, and the landed
payload rule (provider-private state lives on an instance injected across the
boundary) cannot carry it either — `Run.Sequence` holds no durable reference, so a
sequence nested two levels down has no injected instance to read from. So the
context grows one member, and the spec states the consequence plainly: unlike
`zones`, `durable` does **not** cross the ABI — a second runtime threads a handle it
owns. That is what "the kernel is a pure conduit" costs, written down rather than
implied.

This is what makes nesting work without per-module effort: a nested `Run.Sequence` —
in the same module or reached across an import boundary — picks the handle up and
journals its steps under the outer step's path, so a crash inside it resumes inside
it. A composer that offers no deterministic key (an `Ai.Agent` tool loop, whose
sequence the model chooses) becomes a single entry, which is the correct semantic
there.

**Journaling lives in `run`'s step engine**, because a step path is the only
naturally deterministic key available, and it survives concurrency where a call
ordinal would not. `run` gains no dependency: the run handle is reached through the
ambient member, never named in its schemas, so the module stays import-free.

**Replay determinism is normative; the key scheme is normative for the journal, not
for every driver.** Two levels, and conflating them is what would lock a hosted engine
out. The **determinism contract** binds the step engine in every runtime: on replay it
must reach the same steps in the same order, against the same targets, with the same
collapse decisions. Every driver rests on it — a hosted engine asserts exactly this
when it matches replayed frames against re-issued calls — so it belongs in
`kernel/specs/durable-execution.md`, for the same reason
`kernel/specs/invocation-contract.md` is normative ("two runtimes that guess
differently would accept different manifests"), except that here the failure corrupts
durable state instead of rejecting a manifest.

The **key scheme** — how a step path is composed, how loop and branch counters enter
it, the on-disk shape of an entry and a run record — binds any backend that **keys by
path**, `durable-local` first among them: a journal outlives the process that wrote it,
so two step engines keying differently produce one neither can replay. A backend that
assigns its own indices (both hosted engines do) satisfies the determinism contract
instead, which is what makes order-based matching sound. Either way a journaled step
must declare `outputType`: the contract is not only what makes journalability
provable, it is the serialization boundary another runtime reads the entry through.

**The durable zone, and containment, come from the zone mechanism.** Each backend's
workflow kind carries the *providing* annotation on the slot holding the body, and
`Durable.Sleep` / `Durable.Await` carry the *requiring* annotation naming
`Durable.Run` — the marker abstract. Liskov acceptance does the rest: an open
`Restate.Workflow` zone satisfies a `Durable.Run` requirement because it extends it,
with no per-backend rule anywhere.

The slot's `use` differs per backend and each says so honestly: `durable-local`
dispatches the body detached, so `[call, detached]`; `Restate.Workflow` and
`Temporal.Workflow` are re-entered from an inbound route or a worker and await the
body inside that invocation, so `call`.

**The body starts outside every enclosing zone in every case, by two mechanisms.** A
run outlives whatever triggered it, so no enclosing zone's lifetime may reach its body.
`durable-local` gets this from the detach primitive, which replaces the ambient with
the uncancellable root; the hosted backends get it from the landed inbound obligation,
which requires an inbound registrant to dispatch on `rootContext()`. The workflow kind
then layers its zone and the run handle onto that root context, so the construction is
identical and only the provenance of the root differs. A transaction requirement
arriving at the body fails on every path — and because zone state is kernel-owned, the
shedding is deterministic rather than racing a commit. A providing slot discharges
*before* the projection terminates on the edge's `use`, which is what lets a detached
slot both end every enclosing zone and establish its own; that ordering is already in
the landed pass, so no backend needs a change there.

**Containment is a downward walk, and it is new.** The landed projection propagates
requirements callee→caller and answers "is this requirement satisfied"; every check
below asks the opposite question — "what is inside this zone" — so the analyzer gains
a **containment walk**: from a providing field, follow `call` edges of the shared
graph to everything the body reaches. It is a second consumer of the same call graph,
not a second graph, and it is parameterized over the annotation that opens the region
so the durable zone and the attribute-bearing zones share one traversal. It never names
`Durable.Run` — that would be the hardcoded kind knowledge the topology constraint
forbids — so nothing is marked durable by hand and a nested sequence cannot be
forgotten.

Enforcement follows the same division execution zones set: **enforced at runtime,
warned early.** `Durable.Sleep` and `Durable.Await` raise when no run handle is
ambient, which is the real enforcement and holds regardless of how the dispatch
reached them; the satisfaction walk then moves that failure to `telo check` for every
path it can see, so an HTTP route invoking a parking body directly is rejected with
the path rather than at the moment the route is first exercised. The static half may
under-approximate without becoming unsound — a dynamically dispatched edge degrades
to the runtime error, never to silence. What it does **not** provide is a guarantee
that a body's effects were never run un-journaled: a route reaching one through an
edge the analyzer cannot see will execute journal-free steps until it reaches the
first parking point. That residue is why the enforcement has to be at the dispatch,
and why the check is described as early warning rather than as containment.

**A workflow kind is the single body-dispatch site of its backend.** Whatever the
engine, exactly one kind holds the `invoke:` body, carries the providing annotation,
installs the run handle and drives replay — `DurableLocal.Workflow`,
`Restate.Workflow`, `Temporal.Workflow`. Everything else in that backend's module
addresses runs from outside: start, deliver, status, result, cancel, schedule.

**Run identity is native, and every engine already has an opinion.** A workflow kind
takes a `runId:` (a CEL expression over its inputs) and a conflict policy, because a
caller-chosen id is how both hosted engines express an idempotent start — a Restate
workflow key, a Temporal workflow id. What the policy is *called* and which values it
accepts is the engine's own: Temporal has reuse and conflict policies with more states
than Restate's idempotency-key attach, and flattening the two to three shared values
would have been a lossy translation in both directions. `durable-local` implements its
own with the `putIfAbsent` `KeyedClaim` already has.

**Admit before executing — the one rule every backend keeps.** A start that executes
before it is durably recorded is unrecoverable if the process dies in between;
recording first is what lets recovery find a run with no progress and replay it. It is
not a contract method, because there is no shared contract — it is a conformance
requirement in the spec, testable against any backend.

**`durable-local` starts by dispatching detached, in-process.** It writes the run
record, dispatches the body without awaiting it and returns the run id — so an HTTP
route that triggers a run responds immediately while the body keeps going. Three
consequences the detach forces. The body must run under a **fresh cancellation
scope**, because `runInvoke` inherits the ambient token and the run would otherwise be
cancelled the moment the triggering request completed. The run handle and the zone are
**installed on that fresh context, never inherited** — clearing is the whole point of
the detach, and it sheds the `durable` member exactly as it sheds zones, so the
workflow kind builds the body's context from `rootContext()` and layers both onto it
(this is what `withZone`'s `base` parameter is for). And a body that is *running*
holds the kernel (via the existing detached-task tracking) so the application cannot
exit mid-run — it is only the *suspended* state that releases the hold. The trade-off
worth recording: the process that receives the trigger performs the initial execution,
so starts are not balanced across workers; the resumer is the recovery and wake path,
not the scheduler.

**The hosted backends start by enqueueing, and are called back.** They hand the run to
the engine and return the id without executing anything; the engine later reaches the
app — Restate by invoking the mounted endpoint, Temporal by handing the worker a task
— which re-enters the workflow kind on a `rootContext()`. That is the trade
`durable-local` declines: a queue hop's latency on a request-triggered run, bought back
as starts balanced across workers and a schedule the app does not own.

**Suspension is a distinct signal, not an error.** It unwinds the stack, so a
`try:` step must not catch it and `toSequenceError` must not absorb it.

**Retry moves into the step engine, and grows to engine parity.** `retry:` on an
invoke step is currently a no-op: `executeInvokeStep` passes it as a fourth argument
that `ResourceContext.invoke`'s three-parameter signature silently drops, and nothing
in the kernel reads it. The engine takes the attempt loop, so the chokepoint grows no
policy, each attempt gets its own span, and a long retry delay can suspend instead of
holding the process.

`{ attempts, delay }` is not enough for either engine. It gains **exponential
backoff** (`backoff` coefficient, `maxDelay`) and **non-retryable classification**
(`nonRetryable: [<error code>]`) — Temporal's retry policy with non-retryable error
types, and Restate's terminal-versus-retryable distinction, are the same two knobs, and
without them every failing step retries a policy violation to exhaustion. Steps also
gain a **`timeout:`**, which both engines require (Temporal's start-to-close, Restate's
handler timeout) and which is what lets a driver decide where to execute a step —
Temporal runs a short one as a local activity and a long one as an activity, a choice
the manifest should not have to make.

**Attempt state is journaled, not just the final outcome.** The obvious reading —
"only the outcome matters, so journal once" — is wrong the moment a backoff suspends:
a run that parks mid-retry and resumes in another process must know which attempt it
was on and when the next is due, or it restarts the policy from zero and a 3-attempt
cap becomes unbounded. So a suspending backoff records attempt and next-due; a backoff
short enough to sleep in-process still journals only the outcome. The threshold is the
same one that decides whether a delay suspends at all.

**`with:` scopes work unchanged.** Re-creating scoped resources on resume is safe
by contract (`init()` builds, `run()` acts) and in fact required — a sequence
talking to a scoped connection needs it back. Scope targets dispatch through the
kernel chokepoint, so they journal like any step under one rule: journal on
completion. A target that completes is skipped on resume; a long-lived service,
whose `run()` stays pending, has no entry and is re-dispatched, which is exactly
right after the process holding its listener died.

### Zones that constrain their contents

Some bodies must forbid what a zone requirement cannot express. Parking inside a
`Lease.Critical` body is wrong even though the enclosing durable zone legitimately
satisfies the suspension requirement — the lease lapses unrenewed while the run
sleeps, so on resume another holder may already be running.

A transaction is the sharp case, and the failure is silent. If a journal entry is
written for a statement and the process dies before `COMMIT`, the database rolls the
statement back while the journal still records success. Replay then skips it, the
transaction commits empty, and the run reports success over writes that never
landed. Nothing detects it.

**These are properties of a zone, not a new relation.** A body slot that constrains
its contents is a body slot that already establishes a zone — all three shipped
consumers are — so they are **attributes on `x-telo-provides-zone`**, which gains an
object form beside the two shapes it already accepts:

```yaml
x-telo-provides-zone: true                    # unchanged
x-telo-provides-zone: /connection             # unchanged
x-telo-provides-zone:                         # new: correlation + attributes
  key: /connection
  attributes:
    Telo.atomic: a rollback erases writes a journal recorded as done
    Telo.noSuspend: the transaction holds a connection a parked run would lose
```

**The attribute vocabulary is a registry with namespaced extensions** — the pattern
JSON Schema spells `$vocabulary`, IANA spells as a registry (RFC 6648 having
deprecated the `X-` free-for-all that is the alternative), and OpenTelemetry spells as
owner-namespaced semantic conventions. The split it buys is the one this needs: **the
name and shape are registered and validated; the meaning stays with the consumer**,
exactly as IANA registers header names without knowing what any endpoint does with
them. The cautionary half is Kubernetes' `metadata.annotations` — an open string map
where a typo is silent, which is why extension there moved to structural schemas.

A name is either **built-in** (`Telo.atomic`, `Telo.noSuspend`) or **alias-qualified**
(`<Alias>.<name>`), and either way it resolves through the grammar `extends`,
`x-telo-ref`'s `kind` and `x-telo-requires-zone`'s `zone` already use: resolved in the
**declaring** module's scope, canonicalized to `<module>.<name>` at registration by
`resolveSchemaRefKinds`. No new resolution machinery.

An attribute is declared by a new built-in doc kind:

```yaml
kind: Telo.ZoneAttribute
metadata:
  name: noSuspend
  description: >-
    The zone holds something bounded that cannot outlive the current process — a
    connection, a lease, a claim. The value is the consequence, quoted in diagnostics.
schema:
  type: string
  minLength: 1
---
kind: Telo.ZoneAttribute
metadata:
  name: atomic
  description: >-
    Effects inside are discarded together on failure, so a consumer recording them
    individually would record work a rollback erases.
schema:
  type: string
  minLength: 1
requires:
  - Telo.noSuspend
```

`requires:` keeps the completeness rule out of analyzer code: it compiles to JSON
Schema's **`dependentRequired`**, the standard keyword for "if this property is
present, those must be too". The analyzer composes one object schema from the resolved
entries — each contributes its property and its `dependentRequired` clause, and the
whole gets `additionalProperties: false` — so `atomic ⇒ noSuspend` is a declaration in
the registry rather than a hardcoded pair of names.

**Why the two shipped attributes are built-ins.** The same argument that makes
`Telo.JsonSchema` one: they are too fundamental to require an import. Were `atomic`
owned by `modules/durable`, `modules/sql` would have to import durability to describe
its own transaction — the dependency inversion that keeps provide/require clean. And
it would be a lie about ownership: "effects inside are discarded together" is true of
a transaction whether or not anything is journaling it. Durability is a *consumer* of
that fact, not its owner. A third-party attribute (`Saga.compensable`) is
alias-qualified and does need its import, because there the dependency is real.

Each value is the **reason**, required by being the value itself rather than a sibling
of a boolean, and diagnostics print it verbatim. That is also what makes a type check
possible at all — there is no `true` to accept, so `Telo.atomic: true` fails the
declared schema.

Validation lands in the annotation's strict half (`validate-zone-slots.ts`), reading
through its single accessor (`zone-slot.ts`) as the one-accessor rule requires: every
name must resolve to a registered attribute, and every value AJV-checks against that
attribute's schema. Two new codes — `ZONE_ATTRIBUTE_UNKNOWN` (naming the owner and its
declared attributes, the `KIND_NOT_EXPORTED` shape) and `ZONE_ATTRIBUTE_INCOMPLETE` —
plus the existing `ZONE_ANNOTATION_INVALID` for a value of the wrong shape. Like the
other zone validations it is **entry-module-scoped**: a published dependency's
attributes are not the consumer's to fix.

The failure directions are the asymmetry that file exists for. An unread `noSuspend`
parks a run inside a lease; an unread `atomic` journals a statement a rollback will
erase. Neither may be silent, which is the whole reason the vocabulary is registered
rather than free-form.

Three shipped consumers, in two distinct combinations: `Sql.Transaction.steps` — which
already carries `x-telo-provides-zone: /connection` — declares both;
`Lease.Critical.invoke` and `Idempotency.Once.invoke` declare `Telo.noSuspend` only,
since their effects genuinely commit and should be journaled individually. The latter
two become zone providers, which they should be regardless: a lease and an idempotency
claim are exactly the "you are inside my body" relation zones exist to express.

The annotation resolves along `extends`, so an additive child inherits through schema
merge; a `base:`-narrowing child, whose author-facing schema is its own only, is
treated as **wholly** in-zone — conservative, and it avoids tracing which child field
feeds the parent's body through `base:` CEL.

**The runtime half is the landed zone stack plus one accessor, and the kernel
interprets nothing.** The declaring controller already opens its zone with `withZone`
(`sql` does; `lease` and `idempotency` start doing so), and the attributes are read
back off the ambient stack through a new SDK method, **`ctx.zoneAttributes(ctx?)`** —
per open zone, its kind plus the declared bag keyed by canonical name. The kernel
resolves each entry's `kind` to its schema and hands the bag over uninterpreted; it
never branches on a name, exactly as `readRefSlot` hands back `use` without acting on
it. The step engine reads `Telo.atomic` to collapse a zone into one entry;
`Durable.Sleep` and `Durable.Await` read `Telo.noSuspend` and refuse to park, raising
`ERR_DURABLE_SUSPEND_FORBIDDEN` with the declared reason. Both strings live in
`modules/durable`'s code, which is where that vocabulary belongs.

**A collapsed atomic zone is at-least-once, not exactly-once.** A crash between
`COMMIT` and the journal write re-runs the whole zone on resume. That is
unavoidable at the manifest level and is documented rather than implied away; the
mitigation is an idempotent body (upsert, unique constraint) or `Idempotency.Once`
around it.

### Static checks

All topology-driven, no kind named in analyzer code. From the derived durable
zone: impure CEL (`DURABLE_NONDETERMINISM`, reading the catalog's existing
`deterministic` flag, with `Durable.Value` named as the fix); an `x-telo-stream`
property in a journaled result (`DURABLE_UNJOURNALABLE_RESULT`); a journaled step
whose target declares no `outputType` (`DURABLE_CONTRACT_REQUIRED` — the contract
is the serialization boundary).

From `Telo.noSuspend`: any target in the zone carrying a suspension
requirement. That is one rule rather than an enumeration of forbidden kinds, so a
suspension kind added later is covered without touching the check. Two step-level
checks stay separate, being properties of the step rather than of its target: a
retry whose delay would suspend, and a **detached dispatch**. The latter keys off
the dispatch being detached rather than off `Run.Detach` as a kind, so it also
covers `Lease.Critical`'s `detach: true` — either way the journal would record a
completion for work that has not run.

From `Telo.atomic`: a body declaring `requireCheckpoints: true` inside the zone, a
direct contradiction (the callee demands per-step entries, the zone forbids them),
reported naming both sites. The `atomic ⇒ noSuspend` completeness rule is *not* here —
it is the registry's `requires:` compiled to `dependentRequired`, checked at the
annotation rather than by a walk.

Every check above is a consumer of the one containment walk, parameterized over the
annotation that opens the region: the durable zone and the attribute-bearing zones
differ in what they forbid, not in how their contents are found.

These read attribute names the analyzer does not hardcode either — the containment
walk is parameterized over *which* attribute opens the region, and `modules/durable`'s
checks name `Telo.atomic` / `Telo.noSuspend` the same way they name
`DURABLE_NONDETERMINISM`: as this feature's own vocabulary, over a generic mechanism.

### Granularity, failures, and bounds

**Checkpoint granularity** is a cost lever where no zone forces it, declared on
both sides. A step may record only its target's final result rather than the
target's internals; the caller owns that choice because it pays the write and replay
cost, and it is what makes a hot loop or a large projection affordable. A sequence
whose steps are effectful and non-idempotent may forbid being collapsed. Collapsing
is **not** atomicity: the whole target re-runs on resume, so its steps become
at-least-once.

Runtime failures are raised, never degraded: a resume against a moved manifest
digest parks the run (`ERR_DURABLE_MANIFEST_CHANGED`) rather than replaying against
different code, and a replay reaching a different target than the journal records at
that key raises `ERR_JOURNAL_ENTRY_MISMATCH`.

**The digest covers the run's reachable subgraph, and parking is recoverable.** Both
halves matter, because the naive form breaks the feature it implements: a digest over
the whole manifest moves on every deploy, and a deploy is the most common cause of
the process death durability exists to survive — so an unrelated edit would strand
every in-flight run, and a 72-hour approval would rarely survive to be approved. The
digest is therefore taken over what the run's body actually reaches — the same call
graph the containment walk uses, so no new derivation — and an edit outside it parks
nothing. A change *inside* it still parks, correctly: that is changed code under a
live run. `DurableLocal.Resume` is the operator's answer — it force-resumes a parked
run against current code, recording the override as a journal entry so a divergent run
is identifiable afterwards rather than indistinguishable from a clean one. Parking is a
hold, not a grave.

**All of which is `durable-local`'s, and nobody else's.** Restate pins an invocation to
the deployment it started on and Temporal has worker versioning, so in-flight runs
there already execute the code they started with — the engine solved the problem the
digest detects, and parking them would strand runs that were correctly continuing.
Under the union-contract design this needed a declared "do you pin?" capability so the
shared logic could skip itself; native backends need nothing, because the digest,
`ERR_DURABLE_MANIFEST_CHANGED` and `DurableLocal.Resume` simply do not exist outside
the one module that needs them. This is the shape of most of what the split bought.

Long runs are bounded the same way — by whatever the backend has. `durable-local`
**compacts**: the whole run state is the serializable `steps` map, so crossing an entry
threshold records one baseline and truncates, with no replay from zero, and completed
runs are retained for a configured window then purged. Temporal has `continue-as-new`
and Restate's journal is the engine's own. One concept, three native spellings, no
shared verb pretending they are interchangeable.

## Decisions

- **The shared surface is a replay seam, not a portable engine vocabulary** — the seam
  exists so `Run.Sequence` and its step engine do not fork, which is the only thing
  that genuinely must be shared: a backend going fully its own way must otherwise
  re-implement the step engine or invent a step grammar, and the second is what
  `workflow-temporal` did and this plan deletes. Portability is *not* the
  justification, and pretending it was is what inflated the earlier design: in-flight
  runs do not migrate between engines, configuration shares nothing, and nobody
  switches engines twice. Rejected: a union `Durable.Driver` covering admit /
  schedule / cancel / status / result / compact — it forced a lowest common
  denominator on every one of them (three `onConflict` values where Temporal has more,
  one overlap policy set, a "do you pin code versions?" capability flag) while still
  excluding Restate virtual-object state and Temporal search attributes. Also
  rejected: nothing shared at all, which buys full fidelity at the price of the fork.
- **`Durable.Run` is a marker abstract with no operations** — the parking kinds need
  *one* zone kind to require, and the landed Liskov acceptance turns that into
  free satisfaction for every backend's workflow kind. Giving it a schema or a
  controller would immediately start re-accumulating the union surface it replaced.
- **Each backend's workflow kind is the single body-dispatch site of its backend** —
  it owns the providing annotation, the zone, the run handle's installation and run
  identity. Rejected: a shared dispatch kind delegating to a backend, which is exactly
  the union contract under another name.
- **`modules/durable` holds the four shared kinds, not the kernel** — the kernel
  carries the run handle without ever calling it, so it needs no contract; and what
  justified a kernel-owned `Telo.LogSink` (every controller logs, plus a conformance
  requirement) has no analogue. Rejected: a kernel-owned `Telo.Journal`; and a
  standalone `modules/journal`, which would collide with `record-stream`'s existing
  `Journal` kinds on name, alias and hub search — the journal abstract now sits inside
  `durable-local`, where it is one backend's storage seam rather than everyone's.
- **Journaling in the step engine, not at the kernel chokepoint** — a step path is
  deterministic under concurrency; a per-run call ordinal is not, and a kernel-level
  journal would make "is this call journaled?" invisible to `telo check` and the
  editor. Rejected: ambient journaling of every dispatch.
- **`durable-local` gets a dedicated journal contract, not `KvStore.Store`** — "which
  runs are due to wake" is a range query, and `KvStore.Store` is deliberately
  point-access only; widening it would weaken a contract four modules already depend
  on. Rejected: `(runId, seq)` keys over the existing KV backends.
- **Suspension containment reuses the zone mechanism rather than a durability-
  specific rule** — a check at the suspension site would catch one shape and leave
  every transitive path open. Rejected: making the zone slot inline-only, which
  would close the hole structurally but forbid sharing any suspension-bearing
  fragment.
- **Containment is enforced at the dispatch, not by the analyzer** — the parking kinds
  raise when no run handle is ambient, so an edge the analyzer cannot see fails loudly
  rather than silently. The consequence, recorded rather than glossed: a body reached
  through such an edge runs journal-free steps up to its first parking point, so the
  static check is early warning and not a guarantee that no un-journaled effect ran.
- **The durable zone is derived, hooked by the providing annotation** — declaring
  it per sequence means an author can forget a nested one, and the failure mode is
  silent re-execution. Mirrors runtime reach, which is derived and never declared.
- **`durable-local` starts dispatch-detached; the hosted backends enqueue** — routing
  every local start through the resumer's poll interval would put seconds of latency on
  a request-triggered run for no gain in recovery, since admitting the run before
  dispatch already makes an in-between crash recoverable. The hosted backends take the
  queue hop and get balanced starts for it. Under the union contract this had to be
  argued as one model's default; natively it is just what each backend does, and the
  only rule that survives as shared is *admit before executing* — a spec conformance
  requirement, not a contract method.
- **Everything journaled by default, collapse opt-in** — forgetting to journal an
  effectful step re-executes it on replay, which is the failure nobody notices.
  Opt-out puts the burden on the cheap case instead. Rejected: opt-in per step.
- **Collapse permission belongs to the callee** — the side that knows its own
  effects holds the veto; without it the lever is a footgun whose blast radius is
  invisible at the call site.
- **Constraints are attributes on `x-telo-provides-zone`, not a second annotation
  family** — a slot that constrains its contents is a slot that establishes a zone, and
  all three shipped consumers are body slots that already do (or should). A separate
  family would restate the zone's location, its `extends` resolution and its runtime
  open call. Rejected: standalone `x-telo-atomic` / `x-telo-no-suspend`; and a
  kind-level flag, which cannot say *which* field holds the body without hardcoded
  per-kind knowledge (a sibling `afterCommit:` legitimately sits outside the
  transaction).
- **The attribute vocabulary is a registry with namespaced extensions, not an open map
  and not a closed enum** — an open string map makes a typo silent, and a silent
  `noSuspend` is a run parking inside a lease (Kubernetes' `metadata.annotations` is
  the worked example of that failure, and structural schemas were its fix). A closed
  enum in the analyzer validates but makes Telo's release cadence the bottleneck on
  anyone adding a zone property — the objection `CLAUDE.md` already raises against a
  closed category vocabulary. The registry is the third answer, and the one JSON
  Schema (`$vocabulary`), IANA (RFC 6648) and OpenTelemetry all converged on: names are
  registered and validated, meanings stay with consumers. Rejected also:
  consumer-declares-what-it-reads, under which a zone's validity would depend on which
  consumers happen to be in the manifest — the same annotation validating in one app
  and failing in another.
- **`Telo.atomic` and `Telo.noSuspend` are built-ins, not `modules/durable`'s** — the
  `Telo.JsonSchema` argument: requiring an import to state a property of your own zone
  is the wrong shape, and here it would additionally invert the dependency
  (`modules/sql` importing durability to describe a transaction). It is also true on
  the merits — "effects inside are discarded together" holds whether or not anything
  journals them, so durability is a consumer of the fact rather than its owner.
- **`atomic ⇒ noSuspend` is declared in the registry, not checked in code** —
  `requires:` on the attribute compiles to JSON Schema's `dependentRequired`, so the
  rule lives beside the thing it constrains and the analyzer stays free of the pair.
  Rejected: a silent implication, which would leave the suspension diagnostic with a
  generic message — exactly what the required reason exists to prevent.
- **The attributes are read back through `ctx.zoneAttributes`, uninterpreted, not off
  the entry** — a `ZoneEntry` is three identities so it stays ABI-serializable and no
  module reads another's state off the stack; the kernel resolves the declaring kind's
  schema instead, which is the one place that lookup is already available, and hands
  the bag over without branching on a name. Rejected: an attribute field on the entry;
  and a kernel accessor shaped around `atomic` / `noSuspend`, which would have put two
  durability words in a runtime that has no journal to interpret them against.
- **Retry in the step engine, not the kernel** — retry is a composer concern and
  the chokepoint should grow no policy; co-locating it with the journal is what
  lets a long delay suspend rather than block. Rejected: a retry option on
  `runInvoke` (would make the kernel decide what is retryable).
- **A workflow kind returns a run id** — an awaited call cannot survive a suspend, so
  awaiting would make suspension unavailable to the common shape. Each backend's own
  wait verb covers callers that want to block, and being a separate verb is what lets
  it be called from a different process than the one that started the run.
- **Per-run claims, no leader election** — finer-grained, and `KeyedClaim` already
  implements the protocol both `Lease.Critical` and `Idempotency.Once` use. Purely
  `durable-local`'s concern: the hosted engines guarantee a single writer per run
  themselves, and under native backends that asymmetry needs no expression at all.
- **`Durable.Await` returns a backend-minted token, and the wake side is native** —
  addressing a parked run by `(run id, step name)` assumes path keying, which neither
  hosted engine does. The parking half stays shared because it talks only to the run
  handle; the delivering half is `Restate.Awakeable` resolution, a `Temporal.Signal` or
  a `DurableLocal.Deliver`, because that is where the engines genuinely differ. The
  body is portable, the thing that wakes it is not — which is the correct division,
  since whatever wakes a run is outside the body anyway.
- **Run identity is native, not a shared three-value enum** — a caller-chosen id is how
  both hosted engines express an idempotent start, so a workflow kind takes `runId:`;
  but Temporal's reuse and conflict policies have more states than Restate's
  idempotency-key attach, and the union design's `attach | reject | startNew` was a
  lossy translation of both. Each backend spells its own policy.
- **Signal delivery is never body re-entry** — on Restate an exclusive handler queues
  behind the running `run` handler, so routing a deliver through resume deadlocks a run
  against the signal that would wake it. A conformance requirement in the spec rather
  than a contract method, because the failure is a hang with no error and every backend
  must avoid it independently.
- **Durable schedules are native, and `Scheduler.Cron` is not one** — the composition
  (`Scheduler.Cron` invoking a workflow) starts a durable run behind an in-process
  ticker, so a tick taken while the app is down is lost. Each backend ships its own
  schedule kind in its own vocabulary — Temporal's overlap and catch-up policies do not
  have Restate equivalents, which is exactly why the union version had to invent a
  shared policy vocabulary neither engine actually speaks.
- **Retry carries backoff and non-retryable codes, and journals attempt state when it
  suspends** — `{attempts, delay}` matches neither engine, and a suspending backoff
  that journals only the outcome restarts its policy on resume, turning a bounded
  retry into an unbounded one. This one *is* shared, because it lives in the step
  engine rather than in a backend.
- **The manifest digest is `durable-local`'s alone** — replaying against changed code
  is divergence with no error, so the local backend takes a digest over the run's
  reachable subgraph (a whole-manifest digest would park every run on every deploy) and
  `DurableLocal.Resume` force-resumes with the override journaled. The hosted engines
  pin deployments and need none of it — under the union contract that asymmetry needed
  a declared capability flag; natively the machinery just does not exist outside the
  module that needs it. Rejected: auto-branching, a versioning feature, not this one.
- **The run handle is its own `InvokeContext` member, not a zone-entry payload**
  — the entry is three identities *because* that keeps it ABI-serializable, and a
  live handle on it would trade that away for every zone. The payload rule cannot
  carry it either: it wants an instance injected across the boundary, and a nested
  `Run.Sequence` has none. The cost, stated rather than implied: this member does not
  cross the ABI, so a second runtime threads a handle it owns.
- **Journal-inside-the-business-transaction is a follow-up, not shipped** — it is
  the only thing that closes the at-least-once window, and it is reachable in
  `durable-local` since `durable-journal-sql` takes a `Sql.Connection` ref, but "the
  same connection" is a driver-level pooling guarantee that a manifest reference
  cannot promise.
- **`with:` permitted** — forbidding it would be a prohibition standing in for a
  rule that already covers the case (journal on completion). Its one sharp edge —
  observed state from a re-created scoped resource may differ across resume — is
  documented, since it is the same class as any external state moving between runs.
- **Sagas are out of scope, and depend on this** — compensation needs the journal to
  know which steps completed, so it is a later kind built on top, not an
  alternative. Recorded here because collapse reads like atomicity and is not. A
  `Saga.compensable` zone attribute is where it would land — and under the registry
  that is a declaration in the saga module, not an amendment to this spec, which is
  the point of the extension tier existing before anyone needs it.
- **`workflow` and `workflow-temporal` are removed, not deprecated in place** —
  neither was implemented, and the good idea in them (engine support) survives, but
  inverted: instead of one engine-shaped grammar in the manifest, each engine gets its
  own module and the step grammar stays `run`'s. `modules/temporal` is where
  `workflow-temporal` was trying to go. Published
  versions stay resolvable, so a pinned consumer is unaffected. Removal covers the
  module directories, their `.changie.yaml` projects, the `workflow-temporal/nodejs`
  workspace entry, the Workflow topology doc, its `pages/sidebars.ts` entry and the
  reference in `kernel/docs/topology.md`. The workflow canvas that doc describes was
  never built, so no editor code is affected. **No changie fragment is filed for
  either** — `Removed` auto-bumps to 1.0.0 and `check-no-major-module-bump` rejects
  it; a deleted module has no version to move, and regenerating `.changie.yaml`
  drops its project in the same change.

## Complete example — the local backend

```yaml
kind: Telo.Application
metadata:
  name: Onboarding
imports:
  Durable: oci://ghcr.io/telorun/durable@0.1.0
  Local: oci://ghcr.io/telorun/durable-local@0.1.0
  JournalSql: oci://ghcr.io/telorun/durable-journal-sql@0.1.0
  Run: oci://ghcr.io/telorun/run@0.9.0
  # Sql + its backend and the mail module elided with the resources that use them
targets:
  - !ref resumer
---
# extends Durable.Run (the marker abstract) — holds the body, provides the zone
kind: Local.Workflow
metadata:
  name: onboard
journal: !ref runJournal
invoke: !ref onboardSteps
# Idempotent start: submitting the same email twice attaches to the live run
# instead of onboarding twice. Omit runId to have one minted.
runId: !cel "'onboard:' + inputs.email"
onConflict: attach
---
kind: Run.Sequence
metadata:
  name: onboardSteps
requireCheckpoints: true
steps:
  - name: createAccount
    invoke: !ref accountTx
    inputs:
      email: !cel "inputs.email"
    retry:
      attempts: 3
      delay: 10s
  - name: waitForApproval
    invoke: !ref approval
    inputs:
      timeout: 72h
  - name: sendWelcome
    invoke: !ref sendMail
    inputs:
      to: !cel "inputs.email"
      accountId: !cel "steps.createAccount.result.id"
---
# extends DurableLocal.Journal — this backend's storage seam
kind: JournalSql.Journal
metadata:
  name: runJournal
connection: !ref appDb
---
kind: Local.Resumer
metadata:
  name: resumer
workflow: !ref onboard
---
kind: Durable.Await
metadata:
  name: approval
```

`appDb` (a `Sql.Connection`), `accountTx`'s inner statements and `sendMail` are
ordinary resources, elided here. `Durable.Await` needs no configuration and names
nothing: it reaches the run handle ambiently and returns a backend-minted token — the
same reason `Run.Sequence` gains no durable field.

A journal, a resumer and a `runId` policy are **this backend's** vocabulary. The
hosted backends below have none of them, and say so in their own words rather than
implementing an interface that pretends otherwise.

The journal shares `appDb` with the transaction, which is realistic but buys nothing
yet: writing the journal entry inside the business transaction is the deferred
follow-up, so the at-least-once window still applies.

`accountTx` is a `Sql.Transaction`, so its body is one journal entry: a crash inside
it re-runs the whole transaction, which is safe because the database rolled it back.
The step's `retry` sits *outside* the zone and retries the transaction whole — a
retry with a suspending delay *inside* the body would be a diagnostic.

`approval` is a `Durable.Await`: the run parks on its token, releases its kernel hold,
and the application may exit. A `Local.Deliver` call carrying that token — from an
HTTP route, days later, in a different process — wakes it. The resumer re-enters
`onboard`, which replays: `createAccount` returns its recorded result without
re-running the transaction, and execution continues at `sendWelcome`.
`requireCheckpoints: true` means a caller may not collapse this sequence into one
entry, because re-running it would create a second account and send a second email.
Moving `approval` inside `accountTx` would fail `telo check`, printing the transaction
zone's own `Telo.noSuspend` reason.

An HTTP route triggers this by invoking `onboard`, which admits the run, dispatches the
body detached under a fresh cancellation scope, and returns the run id — so the
response goes out while onboarding continues. A route invoking `onboardSteps` instead
fails `telo check`: it carries `approval`'s suspension requirement, and the diagnostic
names that path.

## The same body on a hosted backend

Both manifests below run **the same `onboardSteps`, `accountTx`, `approval` and
`sendMail` docs** as above, byte for byte — they are elided rather than repeated,
which is the claim being demonstrated: the body is portable, and nothing around it
pretends to be. Every doc that *is* shown is written in its engine's own vocabulary,
including the ones with no counterpart in the other two. (Field names are
illustrative; each backend module designs its own schema.)

### Restate — the engine pushes over HTTP

```yaml
kind: Telo.Application
metadata:
  name: Onboarding
imports:
  Durable: oci://ghcr.io/telorun/durable@0.1.0
  Restate: oci://ghcr.io/telorun/restate@0.1.0
  Http: oci://ghcr.io/telorun/http-server@0.9.0
  Run: oci://ghcr.io/telorun/run@0.9.0
ports:
  http:
    env: PORT
    default: 9080
variables:
  restateIngress:
    env: RESTATE_INGRESS_URL
    type: string
  restateAdmin:
    env: RESTATE_ADMIN_URL
    type: string
targets:
  - !ref server
---
# extends Durable.Run. A Restate WORKFLOW — a virtual object whose `run` handler
# executes once per key — so `key` is the run identity and Restate serializes per
# run. A plain Restate service would be concurrent and unkeyed, with none of that.
kind: Restate.Workflow
metadata:
  name: onboard
endpoint: !ref restateEndpoint
name: onboarding
key: !cel "'onboard:' + inputs.email"
idempotency: attach
invoke: !ref onboardSteps
---
# The endpoint Restate invokes to push a run forward. A Telo.Mount, so it goes
# wherever the app already terminates HTTP. Serves each workflow's `run` handler
# plus SHARED handlers for signals and queries — shared because an exclusive one
# would queue behind the running body and deadlock it.
kind: Restate.Endpoint
metadata:
  name: restateEndpoint
ingress: !cel "variables.restateIngress"
admin: !cel "variables.restateAdmin"
advertise: !cel "'http://onboarding:' + string(ports.http) + '/restate'"
---
# Restate's own K/V, keyed by the virtual object — transactional with the
# invocation, which no portable abstraction could have offered.
kind: Restate.VirtualObject
metadata:
  name: onboardingState
endpoint: !ref restateEndpoint
name: onboardingState
---
kind: Http.Server
metadata:
  name: server
port: !cel "ports.http"
mounts:
  - { path: /restate, mount: !ref restateEndpoint }
```

No journal, no resumer, no digest, no `Resume` — Restate owns every one of those
concerns, so none of them appears. Invoking `onboard` POSTs the ingress keyed by `key`
and returns; Restate durably admits the run and then calls `/restate` on this app,
which re-enters the workflow on a `rootContext()` (the landed inbound obligation),
where the zone and run handle are layered on exactly as in the local case.
`Durable.Sleep` becomes a Restate timer, `Durable.Await` an awakeable, and parking
returns a suspension frame on the open invocation rather than writing a wake time.
Waking it is `Restate.Awakeable`'s resolve; asking after it is a shared handler;
stopping it is `Restate.Cancel`, which spells cancel-versus-kill Restate's way.

`Restate.VirtualObject` is the payoff of going native: under the union contract it was
one of three documented exclusions, because no portable `Durable.*` surface could carry
per-key state that is transactional with the invocation. Here it is just a kind.

### Temporal — the worker polls out over gRPC

```yaml
kind: Telo.Application
metadata:
  name: Onboarding
imports:
  Durable: oci://ghcr.io/telorun/durable@0.1.0
  Temporal: oci://ghcr.io/telorun/temporal@0.1.0
  Run: oci://ghcr.io/telorun/run@0.9.0
variables:
  temporalAddress:
    env: TEMPORAL_ADDRESS
    type: string
    default: localhost:7233
  temporalNamespace:
    env: TEMPORAL_NAMESPACE
    type: string
    default: default
secrets:
  temporalApiKey:
    env: TEMPORAL_API_KEY
    type: string
targets:
  - !ref worker
---
kind: Temporal.Client
metadata:
  name: temporal
address: !cel "variables.temporalAddress"
namespace: !cel "variables.temporalNamespace"
apiKey: !cel "secrets.temporalApiKey"
---
# extends Durable.Run. Temporal's own identity vocabulary: a workflow id plus the
# reuse and conflict policies, which have more states than any shared enum carried.
kind: Temporal.Workflow
metadata:
  name: onboard
client: !ref temporal
taskQueue: onboarding
workflowId: !cel "'onboard:' + inputs.email"
idReusePolicy: allowDuplicateFailedOnly
idConflictPolicy: useExisting
invoke: !ref onboardSteps
---
# Temporal is not pushed to — it is polled. A Telo.Service, so it goes in targets.
kind: Temporal.Worker
metadata:
  name: worker
client: !ref temporal
taskQueue: onboarding
---
# A nightly sweep on the ENGINE's schedule: a firing missed while this app is down
# still happens. `Scheduler.Cron` would drop it.
kind: Temporal.Schedule
metadata:
  name: nightlyReconcile
client: !ref temporal
workflow: !ref reconcile
cron: "0 3 * * *"
overlapPolicy: skip
catchupWindow: 1h
---
# Indexed for visibility queries — no portable equivalent, so under the union
# contract this was an exclusion. Here it is a kind.
kind: Temporal.SearchAttribute
metadata:
  name: customerTier
workflow: !ref onboard
field: CustomerTier
value: !cel "inputs.tier"
```

No HTTP surface at all. Invoking `onboard` starts a workflow execution keyed by
`workflowId` and returns; the worker long-polls the task queue, and a workflow task
arriving is what re-enters it. `Durable.Sleep` becomes a workflow timer,
`Durable.Await` a signal token, and replay is Temporal's history feeding recorded
results back rather than an ordered journal read. Waking, asking and stopping are
`Temporal.Signal` / `Temporal.Update`, `Temporal.Query` and `Temporal.Cancel` — four
kinds where Restate has three differently-shaped ones, which is the asymmetry a shared
vocabulary had to erase. Bounding history is `continue-as-new`, driven by the workflow
kind rather than by a shared `compact` verb.

`idReusePolicy` / `idConflictPolicy` are Temporal's, verbatim: the union design flattened
both into one three-value `onConflict`, which could express neither faithfully.
`nightlyReconcile` becomes a Temporal Schedule with its own overlap policy and catchup
window — note it is a *window*, not the boolean `catchUp` the shared version invented.
`reconcile` is another `Temporal.Workflow`, elided.

Temporal's determinism sandbox is the sharp edge, and the plan already answers it: the
normative replay-determinism contract is exactly what a workflow function must
satisfy, and `DURABLE_NONDETERMINISM` rejects the impure CEL that would violate it
before the run ever reaches a worker.

### Where the line falls

**Portable — identical bytes on every backend:**

- the step list itself: sequences, branches, loops, iteration and projection with
  `concurrency`, `Run.Detach`;
- `Durable.Sleep`, `Durable.Await`, `Durable.Value`;
- transactions, leases and idempotency claims, and the `Telo.atomic` /
  `Telo.noSuspend` zone attributes that govern them;
- step `retry` with backoff, `nonRetryable` and `timeout`, because retry lives in the
  step engine;
- `requireCheckpoints` and collapse;
- every static check — `DURABLE_NONDETERMINISM`, `Telo.noSuspend` containment, the
  `outputType` requirement, the detached-dispatch and suspending-retry rules.

**Native — written in the engine's own words, once per backend:**

- the workflow kind, and with it run identity and its conflict policy;
- how a run is started, delayed, scheduled, cancelled, queried, awaited and woken;
- history bounds (`compact` locally, `continue-as-new` on Temporal, engine-side on
  Restate);
- code-version handling (a manifest digest locally, deployment pinning and worker
  versioning on the hosted engines);
- everything an engine has that the others do not: `Restate.VirtualObject` state,
  `Temporal.SearchAttribute`, task-queue routing.

That second list is the one that matters. Under a union contract every line of it was
either a lowest-common-denominator translation or a documented exclusion; here it is
simply each module's own vocabulary, and the two exclusions the earlier design had to
concede — Restate's transactional per-key state and Temporal's search attributes —
are ordinary kinds. **Going native costs a module, not an analyzer change**, because
the static checks key off the zone annotation rather than off any kind.

What it costs, stated plainly: moving a system from one backend to another means
rewriting its start, schedule and cancel docs. That was always true — in-flight runs
do not migrate between engines and the configuration shares nothing — and the earlier
design's promise that a backend swap was one `!ref` was never a promise it could keep.
What *does* move unchanged is the part that took the work to build.
