# Durable execution

**Builds on execution zones**, which have landed: the provide/require annotations,
the ambient zone stack on `InvokeContext`, and the satisfaction walk are in place
(`kernel/specs/execution-zones.md`). This plan adds the replay machinery and the
narrow seam that keeps it from forking across backends, the *containment* walk the
satisfaction walk is the mirror of, and the registered zone attributes a zone uses to
forbid what a requirement cannot express.

**Depends on `plans/step-grammar-in-sdk.md`**, which moves step execution into
`@telorun/sdk` and makes the step schema built-in vocabulary. Two things here rest on
it: every backend's `Workflow` kind carries `steps:` natively rather than pointing a
lone `invoke:` at a separate `Run.Sequence`, and *"the step engine must not fork"* —
the premise the whole backend seam is built on — becomes a structural fact rather than
an argument this plan has to win, because the SDK is symlinked into every controller
bundle instead of inlined.

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
because of a property that fell out of `Run.Sequence`'s design: control flow is a
finite, declared set of CEL expressions over run state, not arbitrary code. So replay
is re-running the step list while returning recorded values instead of computing them.
No continuation capture.

**The journal is closed over everything replay depends on, and that is the load-bearing
property.** The tempting version of the claim — "a run's entire mutable state is the
`steps` map" — is *false*: the CEL scope a step's inputs and a branch's predicate are
evaluated against also carries `resources.<name>` snapshots, `resources.<name>.status`
(a live reading, republished on every dispatch by design), provider values, variables
and secrets. Re-evaluating any of those in a fresh process against freshly-created
resources can yield a different answer, and the sharpest case is silent: a
`Run.Iteration` whose collection comes from a resource read returns a different order
on resume, index N now names a different element, and the journal hands back the
recorded result for that path — with the same target, so no mismatch is detectable.
Wrong results, no error, which is the precise failure durability exists to prevent.

So **the step engine journals its decisions, not only its outcomes**: a step's resolved
inputs, every branch predicate's value, every loop condition, every iteration
collection. On replay these are fed back rather than recomputed. Replay is then a pure
function of `(journal, manifest)` — a **closure property**, and closure is what makes
this survive: an ambient value source added years from now (a new scope variable, a new
binding form, a new provider kind) is covered without anyone re-auditing a list.

The alternative — record a digest of each decision and fail on mismatch — is equally
closed for *detection* and much cheaper, and it is wrong. Observed state is *defined*
as a live reading, so a run that reads one would fail on every resume where the world
had moved, which it usually has. That is not durability; it is fragility with good
error messages. Recording the value removes the failure instead of reporting it.

**This is a structural advantage Telo has and hosted engines do not.** Temporal and
Restate rely on determinism discipline plus divergence detection precisely because
their workflow bodies are arbitrary code with no finite set of decision points; you
cannot journal "the decisions" of a `while` loop in TypeScript without instrumenting
the language. Telo's control flow is declarative, so the decision points are exactly
the CEL expressions the step engine evaluates — an enumerable, statically-known set. A
design should exploit its own structure rather than inherit the constraints of systems
that lack it.

**The shared thing is a narrow replay seam, not a portable engine vocabulary.** The
temptation is to abstract durable execution itself — one `Durable.*` surface every
backend implements. That is what `workflow-temporal` was, and it fails the same way
twice: the abstraction becomes the union of every engine's lifecycle model
(identity policy, schedule overlap rules, cancel-versus-terminate, deployment
pinning), and each backend still loses the half of its own model that did not
generalize. Portability is the stated payoff, and it is close to worthless — in-flight
runs do not migrate between engines, the configuration shares nothing, and nobody
switches durable execution engines twice.

**The real constraint is that the step engine must not fork.** It, the journaling rule,
and every static check over them are Telo-level machinery, and a backend that goes
fully its own way must either re-implement them or define its own step grammar — which
is precisely the engine-specificity this plan deletes. The prerequisite settles half of
that structurally: with the engine in `@telorun/sdk`, which is symlinked into every
controller bundle rather than inlined, there is exactly one implementation no matter
how many backends exist. What still needs a seam is the other half — *whether and where
a step executes*, which is genuinely per-backend. So the seam is sized to that:

- **Shared** — the run-handle interface (`@telorun/sdk`), the `durable` member on
  `InvokeContext` and the suspension signal (kernel), the replay-determinism contract
  and key scheme (spec), and five kinds in `modules/durable`.
- **Native** — everything else. Each backend ships its own module in its own
  vocabulary and exposes its full model, with nothing flattened to a common
  denominator.

**`modules/durable` is five kinds and no operations.**

- **`Durable.Run`** — a **`Telo.Abstract` marker**. It declares no schema, no
  controller and no contract; a backend's workflow kind `extends` it. Its entire job
  is to give the parking kinds one zone kind to require, after which the landed
  Liskov acceptance (*an entry satisfies a requirement when its kind is, or
  transitively extends, the required kind*) makes `Restate.Workflow` and
  `Temporal.Workflow` satisfy it for free.
- **`Durable.Sleep`** — park until a time.
- **`Durable.Await`** — park until a token resolves, returning a backend-minted token;
  declares its own `outputType:`.
- **`Durable.Value`** — pin one impure evaluation, so a region that re-runs reuses the
  value rather than computing a new one.
- **`Durable.Idempotent`** — a body whose re-execution is a no-op, declaring
  `Telo.idempotent` with the author's reason. This is what collapses a region to one
  journal entry (see *Granularity*), and it is a kind rather than a field because
  collapse is a property of a region and a region with a property is a zone. It carries
  its body as native `steps:`.

The parking kinds and `Durable.Value` are shared because they talk to nothing but the
ambient run handle; `Durable.Idempotent` is shared because it talks to nothing at all —
it only declares. Everything with an opinion about *identity, scheduling, delivery or
cancellation* is backend-native, because that is where the engines actually differ and
flattening the differences costs fidelity in both directions.

### What each backend owns

A backend module ships whatever its engine really has, named as its engine names it.
The one thing every backend owes: its `Workflow` kind extends `Durable.Run` **and**
declares `Telo.replayed` on its body slot — the marker so parking kinds resolve, the
attribute so the static checks look inside.

- **`modules/durable-local`** — `Workflow` (extends `Durable.Run`; holds the body,
  provides the zone, owns run identity), `Journal` (an abstract: first-writer-wins
  append, ordered read, run record, due-runs query), `Resumer` (the polling
  `Telo.Service`), `Deliver`, `Status`, `Result`, `Cancel`, `Schedule`, `Resume`.
  `durable-journal-file` and `durable-journal-postgres` extend the journal — the
  `cache`/`cache-redis` shape, one level down from where it used to sit.
- **`modules/restate`** — `Workflow` (registered as a Restate *workflow*, so the run
  id is a virtual-object key), `Endpoint` (the `Telo.Mount` Restate invokes),
  `Awakeable`, `VirtualObject` **with its state**, `Schedule`, `Cancel`.
- **`modules/temporal`** — `Workflow`, `Worker` (the polling `Telo.Service`), `Signal`,
  `Update`, `Query`, `Schedule`, `Cancel`, `SearchAttribute`.

**`durable-local` is a peer, not the reference implementation.** It has no engine to be
native to, so its kinds look like the old generic ones — but it is one backend among
three, and its journal, its resumer and its manifest digest are its own mechanisms, not
obligations on anyone else.

**Two journal backends, and neither is generic SQL nor memory.** A journal is not a
table with rows in it — the operations that matter are claiming due runs without two
resumers taking the same one, and waking promptly. Postgres answers both natively
(`SELECT … FOR UPDATE SKIP LOCKED`, advisory locks, `LISTEN`/`NOTIFY`); a
lowest-common-denominator `Sql.Connection` journal would have to poll and claim in ways
that are correct on neither engine, which is the union-contract mistake this plan
rejects one level up. **`durable-journal-memory` is dropped for a sharper reason:** a
journal that dies with the process has no durability to demonstrate, and shipping one
invites developing against a thing that lacks the single property being built.
`durable-journal-file` fills that role and is genuinely durable, so the dev path and
the production path differ in scale rather than in guarantee.

**The static checks do not care.** They are topology-driven and key off the
`x-telo-provides-zone` annotation, never off a kind — so `DURABLE_NONDETERMINISM`,
`Telo.noSuspend` containment, the `outputType` warning and zone-driven collapse all
apply unchanged to `Restate.Workflow` and `Temporal.Workflow`
without the analyzer knowing either exists. This is what makes native backends
affordable: going native costs a module, not an analyzer change.

**The kernel is a pure conduit** — it carries the run handle and never calls it, so it
needs no contract of its own. `kernel/specs/durable-execution.md` therefore covers
only the kernel's half: handle propagation on `InvokeContext`, the suspension signal
and what must not swallow it, hold release. The step engine consumes the handle
through a TypeScript interface in `@telorun/sdk` — the split logging already makes
between `Logger` / `RecordBuffer` and the `Telo.LogSink` abstract.

**The run handle is three methods, and the middle one is the whole design:**

- **`step(path, target, inputs)` → result.** The step engine hands over an effect to be
  performed; the backend decides *whether* (replay returns the recorded result) and
  *where* (in-process now, or shipped elsewhere and awaited).
- **`decide(path, value)` → value.** A control-flow decision — a resolved input set, a
  predicate, a loop condition, an iteration collection — recorded on first execution
  and returned verbatim on replay.
- **`park(until | token)`.** Suspend the run.

A fourth member is a **question, not an operation**: `writesInside(zone)` — does this
handle's own recording land inside the given ambient zone's atomicity? It is what lets
the step engine stop collapsing an atomic zone when collapsing would be pessimistic
(see *Exactly-once* below). `durable-journal-postgres` answers it with the connection's
`hasOpenTransaction()`; every other backend answers no and behaves exactly as it would
have without the question existing.

**Why `step` and not lookup-plus-record.** The obvious factoring — *have you a result
at this key* / *record this one* — is a leaky decomposition: two halves of a single
operation, split so that the **caller** performs the effect in between. That bakes in
an assumption nothing stated, that the step engine and the resource graph are
co-located. But *where an effect executes* is a real architectural axis, not one
engine's quirk: orchestration is deterministic and cheap, effects are neither, and
separating them is what lets a system scale, version and retry them independently.
Temporal draws that line hard (a workflow isolate does no I/O; every effect leaves as
an activity); Restate collapses it but still marks the boundary with `ctx.run`. A seam
that hardcodes in-process is choosing one side of an axis that a backend will need the
other side of. One operation, backend-chosen implementation — this is not the union
lifecycle contract creeping back, because it is still exactly the replay seam.

**`decide` and `step` are the same mechanism applied to the two things a step engine
produces**, and together they make the engine *relocatable*: once every impure input is
a recorded value, evaluating control flow is a pure function of journaled state, so it
can run in a deterministic sandbox. Decision journaling is not merely a correctness fix
— it is the precondition for a sandboxed backend existing at all.

**Conformance, wherever a step runs:** the executing side MUST dispatch through its
kernel's invocation chokepoint, so the invocation contract, tracing, zones and observed
state hold identically. A backend may move *where* a step executes; it may not move it
outside the runtime's dispatch.

Under `durable-local` all three land in a `DurableLocal.Journal` with in-process
dispatch; under a hosted engine they are protocol frames on the open invocation. The
step engine cannot tell, and that is the entire extent of what the backends share.

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
for every backend.** Two levels, and conflating them is what would lock a hosted engine
out. The **determinism contract** binds the step engine in every runtime: on replay it
must reach the same steps in the same order, against the same targets, with the same
collapse decisions — and it is *discharged by construction*, because every value that
could make it reach a different step is journaled through `decide`. Stating it as a
contract rather than relying on it as an assumption is what lets a backend that matches
replayed frames against re-issued calls assert something real. It belongs in
`kernel/specs/durable-execution.md`, for the same reason
`kernel/specs/invocation-contract.md` is normative ("two runtimes that guess
differently would accept different manifests"), except that here the failure corrupts
durable state instead of rejecting a manifest.

The **key scheme and entry format** — how a step path is composed, how loop and branch
counters enter it, and the on-disk shape of a step entry, a **decision entry** and a
run record — binds any backend that **keys by path**, `durable-local` first among them:
a journal outlives the process that wrote it, so two step engines keying differently
produce one neither can replay. A backend that assigns its own indices (both hosted
engines do) satisfies the determinism contract instead, which is what makes order-based
matching sound. Either way a journaled step must declare `outputType`: the contract is
not only what makes journalability provable, it is the serialization boundary another
runtime reads the entry through. **A decision is serialized under the same rule** — it
is a CEL value, so a decision carrying something unserializable (a live `Stream`, an
instance) is the same defect as an unjournalable result and is reported the same way.

**Target identity is what keeps `step()` from being theatre — the seam fixes its shape,
the spec pins its encoding later.** A step's target arrives at the engine as a *live
instance* — Phase-5 injection has already replaced the `!ref` sentinel — and instance
identity is process-local by construction (`ResourceHandle.ref` is declaration-site
*diagnostics*, and the spec forbids a reverse handle→instance mapping). A backend asked
to execute a step elsewhere therefore has nothing to resolve, which would make the
remote half of the seam unreachable and reduce `step(path, target, inputs)` to
lookup-plus-record under a longer name.

So `step` takes a **declaration-site identity** rather than the live instance alone, and
*that* is the part nothing may move later — it lands with the seam. The **encoding** is
written in the slice that first sends one across a process boundary, because this plan's
own sequencing rule is that a normative format is written where something exercises it,
and a local backend resolves the identity in-process without ever serializing it. The
shape it will take is known, and is derivable identically by the analyzer and at
runtime:

- a module-level resource — `(module ref, resource name)`; names are dot-free by the
  reference grammar's load-bearing invariant, so the pair is unambiguous;
- a `with:`-scoped resource — `(module ref, scope owner, scope site, step path,
  resource name)`. The scope *run* is what makes a scoped instance distinct, and inside
  a durable run a scope run is opened by a step at a determined path, so the tuple is
  deterministic. This is the identity `correlationIdOf` already composes for scoped
  nodes in the analyzer's zone projection;
- an **inline-declared** target — `(module ref, declaring resource name, JSON pointer
  to the declaration)`. Anonymous in the manifest, not anonymous in the graph: the call
  graph already gives an inline declaration its own node.

Sketched here so the seam's target parameter is designed against a real encoding rather
than an open question — but it is a sketch until the slice that ships remote execution
writes it into `kernel/specs/durable-execution.md`. Freezing three encodings normatively
in the slice that cannot exercise any of them is the failure the sequencing rule exists
to prevent.

**Locality is decided by zones, not by a list of exceptions.** A step whose dispatch
sits inside any open zone *other than the durable zone itself* MUST execute locally —
a zone is ambient process state (an open transaction, a held lease), and a remote
executor would have none of it, which the payload rule already says must fail loudly
rather than silently run unzoned. That single rule covers every case a hand-written
list would try to enumerate, and it uses machinery that has landed. Everything else is
the backend's choice.

**The durable zone, and containment, come from the zone mechanism.** Each backend's
workflow kind carries the *providing* annotation on the slot holding the body, with
the **`Telo.replayed` attribute** on it — that attribute, and nothing else, is what
makes a zone durable to the static checks. `Durable.Sleep` / `Durable.Await` carry the
*requiring* annotation naming `Durable.Run`, the marker abstract; Liskov acceptance
does the rest, so an open `Restate.Workflow` zone satisfies a `Durable.Run`
requirement because it extends it, with no per-backend rule anywhere.

The two mechanisms answer different questions and both are needed: the marker abstract
is how a *parking kind* names the zone it must be inside, and the attribute is how the
*analyzer* recognises which zones replay. A backend that declared one without the other
would either have parking kinds that no zone satisfies, or a durable zone the checks
never look inside — so `validate-zone-slots.ts` requires them together on any kind
extending `Durable.Run`.

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
a **containment walk**: from a providing field carrying a given attribute, follow
`call` edges of the shared graph to everything the body reaches. It is a second
consumer of the same call graph, not a second graph, and it is parameterized over
**which attribute** opens the region, so the durable zone (`Telo.replayed`) and the
constraint zones (`Telo.noSuspend`, `Telo.atomic`) share one traversal. It resolves an
attribute name and nothing else — never `Durable.Run`, which would be the hardcoded
kind knowledge the topology constraint forbids — so nothing is marked durable by hand
and a nested sequence cannot be forgotten.

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

**But naming the two known swallowers is not a defence.** The signal passes through
every controller between the parking kind and the workflow — HTTP handlers, `Ai.Agent`
tool loops, `Cache.View`, iteration `catches:`, and any third-party controller with a
`catch (e)` in it. A swallowed suspension silently converts a park into a completed
step and duplicates every effect after it, and a pure-conduit kernel cannot see that
happen. Enumerating the swallowers is unbounded and would go stale on the next module.

So it is **latched, not just thrown**: the parking kind sets a flag on the run handle
at the moment it raises, and the workflow kind treats *an invocation that returned
normally while a suspension is latched* as a hard error
(`ERR_DURABLE_SUSPENSION_SWALLOWED`, naming the parking resource and the step path).
Detection is O(1), needs no cooperation from the swallower, and turns an
unbounded-surface silent corruption into one loud failure at the boundary that owns
the run. The alternative — hoping every controller in the ecosystem rethrows an error
type it has never heard of — is not one.

**Parking inside a concurrent region parks the branch, not the region.** `Run.Iteration`
and `Run.Projection` take a `concurrency:`, so N branches can be in flight when one of
them parks — and parallel-with-waits (fan out to N approvers, wait for all) is a
canonical durable shape, not an edge case. Naive unwinding is wrong in a way that would
be discovered in production: the suspension tears its siblings down mid-step, they have
no journal entry (the rule is journal-on-completion), and they re-run wholesale on
resume. Parallel fan-out would be routinely at-least-once, a property the plan
otherwise reserves for collapsed zones and crash windows *and documents there precisely
because it surprises people*.

The right semantics fall out of the key scheme rather than needing new machinery: a
branch's step paths are already deterministic and index-qualified
(`importAll/iterate[3]/fetch`), so **each branch is already a resumable subtree**. So:

- a branch that parks records its park under its own path and settles as *parked*;
- its siblings **keep running** — the fan-out settles every branch rather than
  propagating the first suspension, the `allSettled` shape with parking as a third
  settlement kind beside resolved and rejected;
- the region propagates suspension only once every branch has completed, failed or
  parked; on resume, completed branches replay from the journal, parked branches resume
  at their park point, and unstarted branches start.

A branch blocked on I/O therefore *delays* the park rather than being destroyed by it,
which is correct and is not a new limitation: no step can suspend mid-flight anyway, so
waiting is strictly better than tearing down. The per-branch catch is a legitimate one
and does not defeat the latch, which is checked at the workflow boundary where the
re-raised suspension arrives.

**A detached dispatch inside a replayed zone is forbidden**, and the replacement is
better than what it forbids. Journal-on-completion would record the *dispatch* as done
while the work runs on, so a resume skips it and a crash loses it — durability's exact
inverse. What an author wants there is a **nested durable run started without
awaiting**: the workflow kind admits it and returns a run id, so the step's outcome is a
journalable value, the child gets its own identity and its own durability, and nothing
is lost on either side. That is what Temporal's child workflows and Restate's one-way
`send` already are. The check keys off the dispatch being detached rather than off
`Run.Detach` as a kind, so it also covers `Lease.Critical`'s `detach: true`.

**Retry already lives in the step engine; what it lacks is engine parity.** The attempt
loop has landed in the SDK's step leaf — `attempts`, `initialDelay`, `factor`,
`maxDelay` and `jitter`, consumed at the leaf rather than handed downstream, so every
dispatch branch reads it and the chokepoint grew no policy. That settles the structural
half this plan depends on: the policy is owned where the journal will be, which is what
lets a long delay suspend rather than block.

Two knobs are still missing, and neither engine works without them.
**Non-retryable classification** (`nonRetryable: [<error code>]`) — Temporal's retry
policy with non-retryable error types and Restate's terminal-versus-retryable
distinction are the same knob, and without it every failing step retries a policy
violation to exhaustion. And a step **`timeout:`**, which both engines require
(Temporal's start-to-close, Restate's handler timeout) and which the
`step(path, target, inputs)` seam makes actionable: a backend that chooses *where* a
step executes needs to know how long it may take — Temporal runs a short one as a local
activity and a long one as an activity, a choice the manifest should not have to make.
Under a lookup-plus-record seam a backend had no such choice and this justification did
not hold.

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
---
kind: Telo.ZoneAttribute
metadata:
  name: idempotent
  description: >-
    Re-executing the zone is observably a no-op — the same writes land, or land
    once. Distinct from atomic: nothing is discarded, so there is no rollback for a
    consumer's own records to participate in.
schema:
  type: string
  minLength: 1
---
kind: Telo.ZoneAttribute
metadata:
  name: replayed
  description: >-
    Execution inside the zone may be re-run from a record of a previous execution,
    so it must reach the same decisions and its results must be serializable.
schema:
  type: string
  minLength: 1
```

**`Telo.replayed` is what makes a zone durable — nothing else does.** Without it the
static-check story does not close: `x-telo-provides-zone` is worn by every
`Sql.Transaction` today and by leases and idempotency claims after this plan, so a
walk keyed on the bare annotation would apply `DURABLE_NONDETERMINISM` and its
siblings to the inside of every transaction in the ecosystem. Each backend's workflow
kind declares it on the slot holding the body, beside its providing annotation, and
every durable check keys off it exactly as the suspension check keys off
`Telo.noSuspend`. That is what makes "one containment walk parameterized over the
attribute that opens the region" literally true rather than nearly true, and it is why
no check names `Durable.Run`.

`requires:` keeps the completeness rule out of analyzer code: it compiles to JSON
Schema's **`dependentRequired`**, the standard keyword for "if this property is
present, those must be too". The analyzer composes one object schema from the resolved
entries — each contributes its property and its `dependentRequired` clause, and the
whole gets `additionalProperties: false` — so `atomic ⇒ noSuspend` is a declaration in
the registry rather than a hardcoded pair of names.

**Why the four shipped attributes are built-ins.** The same argument that makes
`Telo.JsonSchema` one: they are too fundamental to require an import. Were `atomic`
owned by `modules/durable`, `modules/sql` would have to import durability to describe
its own transaction — the dependency inversion that keeps provide/require clean. And
it would be a lie about ownership: "effects inside are discarded together" is true of
a transaction whether or not anything is journaling it. Durability is a *consumer* of
that fact, not its owner. A third-party attribute (`Saga.compensable`) is
alias-qualified and does need its import, because there the dependency is real.

`Telo.replayed` is built-in for a second reason that decides where code lives: **the
analyzer must name whatever the durable checks key off**, since a module cannot
contribute an analyzer pass. Naming a built-in attribute is the analyzer using its own
vocabulary — the same standing it has to name `Telo.Executable` or `x-telo-type`.
Naming a module-owned `Durable.replayed` would make `modules/durable` part of the
analyzer's surface, and naming `Durable.Run` would be the hardcoded kind knowledge the
topology constraint forbids. The same argument covers `run`'s step engine reading
`Telo.atomic` without importing anything.

Each value is the **reason**, required by being the value itself rather than a sibling
of a boolean, and diagnostics print it verbatim. That is also what makes a type check
possible at all — there is no `true` to accept, so `Telo.atomic: true` fails the
declared schema.

Validation lands in the annotation's strict half (`validate-zone-slots.ts`), reading
through its single accessor (`zone-slot.ts`) as the one-accessor rule requires: every
name must resolve to a registered attribute, and every value AJV-checks against that
attribute's schema. Three new codes — `ZONE_ATTRIBUTE_UNKNOWN` (naming the owner and
its declared attributes, the `KIND_NOT_EXPORTED` shape), `ZONE_ATTRIBUTE_INCOMPLETE`
(a `requires:` dependency unmet), and `DURABLE_ZONE_UNMARKED` (a kind extending
`Durable.Run` whose body slot omits `Telo.replayed`, so parking kinds would resolve
against a zone the checks never look inside) — plus the existing
`ZONE_ANNOTATION_INVALID` for a value of the wrong shape. Like the other zone
validations it is **entry-module-scoped**: a published dependency's attributes are not
the consumer's to fix.

The failure directions are the asymmetry that file exists for. An unread `noSuspend`
parks a run inside a lease; an unread `atomic` journals a statement a rollback will
erase. Neither may be silent, which is the whole reason the vocabulary is registered
rather than free-form.

Four shipped consumers, in three distinct combinations. `Sql.Transaction.steps` — which
already carries `x-telo-provides-zone: /connection` — declares `Telo.atomic` and
`Telo.noSuspend`. `Idempotency.Once.invoke` declares `Telo.idempotent` and
`Telo.noSuspend`: its claim genuinely makes re-execution a no-op, so it *earns* the
attribute rather than asserting it. `Lease.Critical.invoke` declares `Telo.noSuspend`
alone — a lease makes nothing idempotent. `Durable.Idempotent.invoke` declares
`Telo.idempotent` on the author's word, which is the whole reason the kind exists: the
hot-loop case where a durable claim per iteration would cost more than the journal
writes it saves.

`Lease.Critical` and `Idempotency.Once` become zone providers, which they should be
regardless: a lease and an idempotency claim are exactly the "you are inside my body"
relation zones exist to express.

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
it.

**Who reads which string, stated once, because they are three different places:**

| Attribute | Read by | Where |
| --- | --- | --- |
| `Telo.atomic` | the step engine, to collapse a zone into one entry *unless the run handle attests its writes are inside it* | `modules/run` |
| `Telo.idempotent` | the step engine, to collapse unconditionally; and the containment walk, for `DURABLE_NONDETERMINISM` | `modules/run`, `analyzer` |
| `Telo.noSuspend` | `Durable.Sleep` / `Durable.Await`, raising `ERR_DURABLE_SUSPEND_FORBIDDEN` with the declared reason | `modules/durable` |
| `Telo.replayed` | the containment walk, to find what is inside a durable zone | `analyzer` |

None of the three is a kernel branch and none is an import: a built-in attribute name
is a string every layer may spell, which is exactly what the built-in tier is for.

### Exactly-once, where the journal shares the transaction

Collapse is the *fallback*, not the goal. A collapsed atomic zone is at-least-once —
the whole zone re-runs on resume, because a crash between `COMMIT` and the journal
write leaves work done and unrecorded. That is unavoidable **only while the journal is
somewhere else**. When the journal writes into the very transaction whose effects it
records, `COMMIT` is atomic over both and the window closes: either the write and its
entry both land or neither does. This is in scope, and it is what makes durable
execution worth having on a plain Postgres.

**The hard part is already built.** The obstacle was stated as "the same connection is a
driver-level pooling guarantee that a manifest reference cannot promise" — true of the
manifest, and irrelevant, because the zone stack answers it at runtime. `sql`'s
connection already resolves an *undeclared* statement against `zonesFor(this)` and
executes it on the open transaction's executor when one is correlated on that
connection (`sql-connection-base.ts`); a foreign zone throws rather than silently
falling back. So a journal that holds the same `Sql.Connection` and issues an ordinary
append while the transaction zone is open is **already writing inside it**. Nothing in
`modules/sql` changes. Pooling is a non-issue because the executor map is keyed on the
zone entry, not on the pool.

**What has to change is the collapse rule.** As written, `Sql.Transaction` declares
`Telo.atomic`, the step engine collapses, and the inner steps get no entries at
all — which forecloses the very thing that would make them exactly-once. So:

> **Collapse an atomic zone unless the run handle attests that its entries land inside
> that zone's atomicity.**

This is not an override of the attribute; it is the attribute read correctly.
`Telo.atomic` says *effects inside are discarded together* — collapse follows only when
the journal's own writes are **not** among them. When they are, per-step journaling is
consistent by construction, and it is strictly better: finer replay granularity and no
re-running a committed transaction. The attestation is one question the run handle
answers, and `durable-journal-postgres` answers it with the connection's existing
`hasOpenTransaction()`. The file journal always answers no, and gets today's collapse.

**The outer step closes too, without an entry inside the transaction.** The step whose
target *is* the transaction records after `COMMIT`, so its own window stays open — but
it is now harmless. A crash there replays the step, which re-invokes the transaction;
every inner step returns its recorded result instead of executing, the transaction
commits empty, and the outer entry is written. No duplicate effect, at the cost of one
empty transaction. That is why per-step journaling inside the zone is what closes the
hole, rather than a pre-commit hook on the zone mechanism — which would have been new
kernel surface for a case this arrangement already covers.

**What stays at-least-once, stated precisely:** a non-transactional effect inside a
transactional zone. An HTTP call in a `Sql.Transaction` body is not rolled back while
its journal entry is, so replay repeats it. Exactly-once is a property of *effects in
the same database as the journal* — not of durable execution in general — and the
mitigation is unchanged: an idempotent body, or `Idempotency.Once` around it.

### Static checks

All topology-driven, no kind named in analyzer code — every rule below keys off a
built-in **zone attribute**, and all of them live in the analyzer.

From `Telo.replayed`, which is what marks a zone durable: a **`live`-representation
value** in a journaled result or decision (`DURABLE_UNJOURNALABLE_RESULT` — a live
handle is not a recordable value in either position). The rule keys off the `live` field
of the `x-telo-type` vocabulary rather than off `Telo.Stream`, for the reason that
vocabulary is data: a live type added later is covered by its entry alone, and the
analyzer names a representation rather than a type. And a **detached dispatch**
(`DURABLE_DETACH_FORBIDDEN`, naming the nested durable run as the replacement). The
latter belongs here and not under `Telo.noSuspend`: the defect is that the journal
would record a completion for work that has not run, which is a *journaling* failure
and has nothing to do with parking.

**`DURABLE_CONTRACT_REQUIRED` is a warning, and the runtime is the gate.** Demanding
`outputType` on every journaled step's target was over-claiming twice over. It does not
prove what it advertises — the contract resolver's layers mean a declared
`{type: object, additionalProperties: true}` satisfies the check and proves nothing,
while an undeclared contract merely falls back to the same permissive shape. And it has
no adoption path: `sql` declares one `outputType` in the whole module and
`Sql.Transaction` declares none, so the plan's own headline example would fail its own
check at `createAccount`. A rule whose first casualty is the example is not a rule.

What actually holds is the runtime: a value that fails to serialize at journal time
raises `ERR_DURABLE_UNJOURNALABLE_VALUE` **at the step path that produced it**, which is
as actionable as a static error and is true regardless of what was declared. The
warning stays because a declared contract is genuinely better — the invocation contract
validates the value at dispatch, so a journaled result that passed one has already been
checked — but "better" is a warning's job. This is the same *enforced at runtime,
warned early* division already chosen for suspension containment, applied to the same
kind of problem.

`Durable.Await` therefore gains an **`outputType:` property of its own** (the
`JS.Script` pattern: `x-telo-ref: Telo.Type`, narrowing one instance's result). It was
previously described as needing no configuration, which was wrong in a way the check
exposed: what a delivery carries is per-instance by nature, and an await that cannot
describe its own payload cannot be type-checked by anything downstream either.

**The delivering side is native, so the tie is a ref, not a second contract.** There is
no shared `Durable.Deliver` to carry the matching `inputType:` — waking a run is
`DurableLocal.Deliver`, `Restate.Awakeable` resolution or a `Temporal.Signal`. Each
backend's deliver kind instead takes an **`await:` ref slot** and derives its payload
schema from that resource's declared `outputType` through the sibling-ref schema
derivation (`x-telo-schema-from`), reading the *instance's* narrowed type — the same
layer-1 per-instance resolution `steps.<name>.result` typing already performs. The await
declares the shape once and the delivery is checked against it, with no analyzer code
naming a durable kind. A delivery that names no await — a token addressed from outside
the manifest — is unchecked by construction and validated at the await when it arrives,
which is the *enforced at runtime, warned early* division this plan takes everywhere
else.

**`DURABLE_NONDETERMINISM` keys on `Telo.idempotent`, where it says something true.**
Impure CEL in a *journaled* position is not a defect — it is the correct semantic:
`!cel "now()"` in a step's inputs is recorded on first execution and replayed
identically, which is what a durable timestamp should do and what `workflow.now()`
means on Temporal. So the rule needs the case where CEL is re-evaluated *and* the
divergence matters, and that case has a name now.

A `Telo.idempotent` region re-runs on resume with its prior effects **intact**, because
nothing discarded them — the region's whole claim is that re-running is a no-op. Impure
CEL falsifies exactly that claim: `!cel "uuid()"` as an idempotency key writes record A
on the first pass and record B on the second, so the re-run is not a no-op and the
assertion the author signed is false. The diagnostic can say precisely that, and
`Durable.Value` makes it true again by pinning the value.

`Telo.atomic` is the wrong trigger, in both directions. Too wide: since collapse became
conditional on the attestation, an atomic zone sharing the journal's transaction is not
collapsed and its decisions *are* journaled, so a static trigger fires on the
configuration this plan recommends and has authors rewriting correct manifests. Too
narrow: an atomic zone that *does* re-run is a **retry, not a replay** — its effects
were discarded, so a fresh timestamp is simply a fresh attempt. The residue stays
documented rather than checked: a non-transactional effect inside a transactional zone
is not rolled back, so with impure CEL it re-runs divergently, and which effects are
transactional is not statically determinable.

From `Telo.noSuspend`: any target in the zone carrying a suspension requirement. That
is one rule rather than an enumeration of forbidden kinds, so a suspension kind added
later is covered without touching the check. One step-level check stays separate, being
a property of the step rather than of its target: a retry whose delay would suspend.

Nothing keys off `Telo.atomic` statically. The contradiction check it used to need —
`requireCheckpoints` declared inside an atomic zone — went with the field, which is what
happens when two mechanisms answering one question are replaced by one. The
`atomic ⇒ noSuspend` completeness rule is not a walk either: it is the registry's
`requires:` compiled to `dependentRequired`, checked at the annotation.

Every check above is a consumer of the one containment walk, **parameterized over the
attribute that opens the region** — `Telo.replayed`, `Telo.noSuspend` or
`Telo.idempotent`. The zones differ in what they forbid, not in how their contents are
found, and the walk itself resolves nothing but an attribute name.

### Granularity, failures, and bounds

**Checkpoint granularity is not a field on either side.** The earlier design had a
caller-side `checkpoint: collapse` and a callee-side `requireCheckpoints:` veto, and it
was wrong in four ways at once: a boolean where every neighbouring annotation carries a
reason; the opposite polarity from *everything journaled by default* (collapse
permitted unless someone remembers to forbid it, and forgetting is silent); a veto that
existed only on `Run.Sequence`, so collapsing a `JS.Script` or an imported invocable had
no protection at all; and a contradiction check needed to reconcile it with
`Telo.atomic`. Underneath all four, collapse was sold as a cost lever while being a
correctness decision — it silently converts exactly-once into at-least-once.

**Collapse is a property of a region, so it is declared the way every other region
property is: a kind that provides a zone.** The rule has no fields in it:

> A region collapses to one entry when **re-running it is safe** — because its effects
> are discarded together, or because re-running is a no-op.

```yaml
kind: Durable.Idempotent
metadata:
  name: importAll
invoke: !ref importBody
reason: every write is an upsert keyed on the source id, so a re-run overwrites itself
```

Three providers, differing in whether they **enforce** the property or **assert** it.
`Sql.Transaction` declares `Telo.atomic` and the database enforces it.
`Idempotency.Once` declares `Telo.idempotent` and its claim enforces it.
`Durable.Idempotent` declares `Telo.idempotent` and takes the author's word — which is
the point of it existing: a hot loop where a durable claim per iteration would cost more
than the journal writes it saves.

**The new attribute cannot be `Telo.atomic`, and the distinction is load-bearing.**
`Telo.atomic` means *effects discarded together*, and the exactly-once machinery depends
on that literally — per-step journaling is safe inside a transaction precisely because a
rollback erases the entries too. A `Durable.Idempotent` region rolls nothing back, so
borrowing `Telo.atomic` would make the attestation relax collapse for it and journal
per-step, recording entries for effects that will re-run. Hence:

- **`Telo.atomic`** — collapse *unless* the run handle attests it writes inside that
  atomicity.
- **`Telo.idempotent`** — collapse, full stop: there is nothing for the journal to be
  inside, and re-running is a no-op either way.

**Collapse suppresses per-step entries, not the journal.** A direct `decide` — what
`Durable.Value` and the parking kinds issue — still records, which is what lets
`Durable.Value` work inside a collapsed region rather than be a prescription with
nowhere to write.

What this removes: two manifest fields, one contradiction check, and the veto. A
sequence is never collapsed because nobody wrapped it, so per-step journaling is the
default with no opt-out to forget — and a wrap is a visible resource in the wrapper's
own manifest, carrying a written reason, rather than a key buried in a step.

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
**compacts**: crossing an entry threshold records one baseline and truncates, with no
replay from zero, and completed runs are retained for a configured window then purged.
Compaction is well-defined precisely *because* decisions are journaled — the baseline
is the run's replay-closed state and nothing else, so there is no ambient value a
truncated run would have to re-derive. Under outcome-only journaling a baseline would
have been a snapshot of something whose boundary nobody could state. Temporal has `continue-as-new`
and Restate's journal is the engine's own. One concept, three native spellings, no
shared verb pretending they are interchangeable.

## Decisions

- **Decisions are journaled, not re-evaluated** — the replay-closed state of a run is
  its journal, and that closure is the property everything else rests on. Outcome-only
  journaling leaves step inputs, predicates, loop conditions and iteration collections
  re-derived in a fresh process from a CEL scope that carries live readings
  (`resources.<name>.status` is republished on every dispatch *by design*), so a
  reordered collection silently maps a recorded result onto a different element with
  no mismatch to detect. Rejected: **digest-and-detect**, which is equally closed for
  detection and much cheaper, but converts every legitimate change in a live reading
  into a failed run — fragility with good error messages, not durability. Rejected
  also: a **provenance check** (flag CEL through `.status` / providers / snapshots
  inside a replayed region), which under-approximates on dynamic edges and, once
  decisions are journaled, would flag code that is correct. This is a place Telo can
  go where Temporal and Restate cannot: their bodies are arbitrary code with no finite
  set of decision points, while Telo's control flow is a declared, enumerable set of
  CEL expressions.
- **The seam mediates step execution, not just its record** — `step(path, target,
  inputs)` rather than lookup-then-record. The latter is a leaky decomposition: two
  halves of one operation, split so the caller performs the effect in between, which
  silently fixes the step engine and the resource graph in one process. *Where an
  effect executes* is a real architectural axis — orchestration is deterministic and
  cheap, effects are neither — and a seam that hardcodes in-process chooses one side
  of it permanently. Temporal draws the line hard, Restate collapses it but still
  marks it with `ctx.run`. Rejected: three methods with the caller dispatching, which
  is cheaper today and unfixable later. The conformance rule that keeps it honest: a
  step executed anywhere MUST go through that side's invocation chokepoint, so
  contracts, tracing, zones and observed state hold wherever it ran.
- **Target identity is a declaration-site identity in the seam, pinned normatively only
  where it crosses a process** — a target reaches the step engine as a live instance,
  and instance identity is process-local (`ResourceHandle.ref` is diagnostics-only and
  there is deliberately no handle→instance mapping), so without a declaration-site
  identity the remote half of `step()` is unreachable and the seam collapses back into
  lookup-plus-record. What lands with the seam is therefore the *shape* — `step` takes
  an identity, not the instance alone — while the encoding (module ref plus resource
  name; scope owner, scope site and step path for a scoped instance; a JSON pointer for
  an inline declaration) is written in the remote-execution slice. Rejected: leaving
  `target` opaque and scoping the seam to in-process — that would be honest only if the
  Temporal-isolate rationale were dropped with it, since it is doing work the design
  could not otherwise cash. Rejected also: freezing all three encodings normatively in
  the slice that introduces the seam, which would declare a format nothing in that slice
  can exercise — the failure this plan's own sequencing rule names.
- **Execution locality is decided by open zones, not by an exception list** — a step
  dispatched inside any zone but the durable one MUST run locally, because a zone is
  ambient process state and a remote executor has none of it. One rule, resting on
  landed machinery, covering every case an enumeration would chase; and it is the same
  polarity as the payload rule, which already says an unrecognised zone entry must fail
  loudly rather than silently run unzoned.
- **A parking branch parks itself; its siblings settle** — naive unwinding tears down
  in-flight siblings that have no journal entry, making parallel fan-out routinely
  at-least-once, which is a property this plan documents elsewhere precisely because it
  surprises people. Branch step paths are already index-qualified, so each branch is
  already a resumable subtree and the semantics cost no new machinery: settle every
  branch (completed, failed or parked), then propagate. Rejected: forbidding suspension
  inside a concurrent region (cheap and honest, but parallel-with-waits is a canonical
  durable shape and forbidding it would push authors to hand-rolled sequential fan-out);
  and region-level barriers that journal in-flight branches, which has no answer for a
  branch blocked on I/O.
- **Detach inside a replayed zone is forbidden, and replaced rather than merely
  banned** — journal-on-completion would record the dispatch as done while the work
  continues, so a resume skips it and a crash loses it. A nested durable run started
  without awaiting gives the same fire-and-forget shape *with* durability on both
  sides, and its run id is a journalable step outcome. Temporal child workflows and
  Restate's one-way `send` are the same construction. Rejected: journaling the detach
  as complete and documenting the fire-and-forget semantics, which would put a silent
  work-loss window inside the feature that exists to remove them.
- **`decide` and `step` are one mechanism, and it is what makes the engine
  relocatable** — once every impure input is a recorded value, evaluating control flow
  is a pure function of journaled state and can run in a deterministic sandbox.
  Decision journaling is therefore not only a correctness fix; it is the precondition
  for a sandboxed backend being possible at all. The two decisions above were reached
  separately and turned out to be the same one.
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
- **`modules/durable` holds the five shared kinds, not the kernel** — the kernel
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
- **Collapse is a kind, not a field on either side** — `Durable.Idempotent` wraps a
  body and declares `Telo.idempotent` with a required reason. The fields it replaces
  (`checkpoint: collapse` at the caller, `requireCheckpoints:` as the callee's veto)
  were wrong four ways: a boolean where every neighbouring annotation carries a reason;
  the opposite polarity from *everything journaled by default*, so forgetting to veto
  was silent; a veto available only on `Run.Sequence`, leaving a collapsed `JS.Script`
  or imported invocable unprotected; and a contradiction check to reconcile it with
  `Telo.atomic`. A region with a property is a zone, and the zone mechanism already
  expresses it — so the veto does not move, it disappears: nothing collapses a sequence
  because nothing wrapped it, and a wrap is a visible resource carrying a written
  justification rather than a key buried in a step. Rejected: keeping a caller-side
  field with a mandatory reason, which fixes the boolean and the veto but leaves
  collapse expressible on any call site without the callee's knowledge.
- **`Telo.idempotent` is a separate attribute from `Telo.atomic`** — atomic means
  effects are *discarded together*, and the exactly-once machinery reads it literally:
  per-step journaling is safe inside a transaction because a rollback erases the
  entries too. A `Durable.Idempotent` region rolls nothing back, so borrowing
  `Telo.atomic` would make the attestation relax collapse for it and journal per-step,
  recording entries for effects that will re-run. Atomic collapses *unless* the journal
  is inside it; idempotent collapses full stop.
- **Enforcement and assertion are different kinds, not a flag** — `Idempotency.Once`
  earns `Telo.idempotent` through its claim; `Durable.Idempotent` asserts it. Both
  declare the same attribute because the *region's* property is the same; which one an
  author reaches for is a cost decision, and it is visible in the manifest as a
  different kind rather than a boolean on one.
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
- **`Telo.replayed` is what marks a zone durable, not the `Durable.Run` kind** — the
  providing annotation alone cannot serve: transactions wear it today and leases and
  idempotency claims will, so a walk keyed on the bare annotation would apply
  `DURABLE_NONDETERMINISM` inside every `Sql.Transaction` in the ecosystem. An
  attribute makes "one containment walk parameterized over the attribute that opens the
  region" literally true, and keeps the analyzer naming only built-in vocabulary.
  Rejected: keying the durable checks off the marker abstract resolved through
  `extends` — cheaper, but it puts a kind in analyzer code and `modules/durable` in the
  analyzer's surface.
- **A swallowed suspension is detected by a latch, not prevented by convention** — the
  signal unwinds through every controller between the parking kind and the workflow, so
  enumerating the swallowers is unbounded and stale on the next module. Latching at
  throw and failing when an invocation returns normally with the latch set is O(1),
  needs no cooperation, and converts a silent duplicated effect into one loud error.
- **`atomic ⇒ noSuspend` is declared in the registry, not checked in code** —
  `requires:` on the attribute compiles to JSON Schema's `dependentRequired`, so the
  rule lives beside the thing it constrains and the analyzer stays free of the pair.
  Rejected: a silent implication, which would leave the suspension diagnostic with a
  generic message — exactly what the required reason exists to prevent.
- **A missing `outputType` is a warning; unserializability is a runtime error** — the
  hard version proved nothing (a declared `additionalProperties: true` satisfies it, and
  an undeclared contract falls back to the same shape) and had no adoption path: `sql`
  declares one `outputType` in the entire module and `Sql.Transaction` declares none, so
  this plan's own example would have failed at `createAccount`. What holds instead is
  `ERR_DURABLE_UNJOURNALABLE_VALUE` at the producing step path, as actionable and true
  regardless of declarations — the *enforced at runtime, warned early* division already
  chosen for containment. Rejected: a cross-module `outputType` sweep, which would block
  every slice behind a change with a release fragment per module; and scoping the hard
  error to relocating backends, which would make a manifest's validity depend on which
  backend later reads its journal.
- **`DURABLE_NONDETERMINISM` keys on `Telo.idempotent`, not `Telo.atomic`** — on the
  idempotent attribute it states something true and specific: you asserted re-running
  this region is a no-op, and `uuid()` inside it makes that false. On the atomic
  attribute it was wrong twice — too wide, because collapse is conditional on a runtime
  attestation, so it fires on the configuration this plan recommends (postgres sharing
  the transaction) where the zone is not collapsed and decisions *are* journaled; and
  too narrow, because an atomic zone that re-runs is a **retry, not a replay**, its
  effects having been discarded. Rejected: making the attestation static by declaring
  the shared connection on the journal kind, which hard-codes a runtime property into
  the manifest and is wrong the moment pooling or routing changes underneath it.
- **Collapse suppresses step entries, not the journal** — `Durable.Value` is prescribed
  as the fix for nondeterminism inside a collapsed region, so a collapse that silenced
  all recording would make the prescribed fix impossible. A direct `decide` records
  regardless; only per-step entries for the steps inside are suppressed.
- **`Durable.Await` declares its own `outputType`, and the backend's deliver kind refs
  the await rather than restating it** — what a delivery carries is per-instance by
  nature (the `JS.Script` narrowing pattern), and the earlier "needs no configuration"
  framing meant an await's result could not be type-checked by anything downstream. But
  delivery is native, so there is no shared kind to hold the matching `inputType`, and a
  hand-copied one would be a second declaration of the same shape with nothing keeping
  the two agreed. An `await:` ref slot whose payload schema derives from the referenced
  instance's `outputType` (`x-telo-schema-from`) is one declaration checked at both ends.
  Rejected: a shared `Durable.Deliver`, which would put the half of the lifecycle that
  most differs per engine back into the shared module; and leaving the delivery side
  untyped, which types the await against a payload nothing is held to.
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
- **Journal-inside-the-business-transaction is in scope, and needs no new primitive** —
  it is the only thing that closes the at-least-once window, and the objection that
  retired it ("the same connection is a driver-level pooling guarantee a manifest
  reference cannot promise") was answered by the zone work: `sql`'s connection already
  resolves an undeclared statement against `zonesFor(this)` onto the open
  transaction's executor, keyed on the zone entry rather than on the pool. What was
  missing was not a mechanism but a rule — **collapse an atomic zone only when the run
  handle's writes are not inside it**. Rejected: a pre-commit hook on the zone
  mechanism, which would be new kernel surface to place the *outer* step's entry inside
  the transaction; unnecessary, because per-step journaling makes replaying that step
  an empty transaction rather than a duplicate effect.
- **Exactly-once is scoped to effects sharing the journal's database, and said so** —
  a non-transactional effect inside a transactional zone (an HTTP call in a
  `Sql.Transaction` body) is not rolled back while its entry is, so it stays
  at-least-once. Claiming exactly-once for durable execution in general would be the
  kind of guarantee that is true in the demo and false in production.
- **Postgres, not generic SQL, and no memory journal** — a journal's hard operations
  are claiming due runs without duplication and waking promptly, and Postgres answers
  both natively (`FOR UPDATE SKIP LOCKED`, advisory locks, `LISTEN`/`NOTIFY`) where a
  portable `Sql.Connection` journal could only poll. Rejected: `durable-journal-sql`
  over the `Sql.Connection` abstract — the same union-contract mistake this plan
  rejects for engines, one level down. Rejected also: `durable-journal-memory`, which
  would be a durability feature with the durability removed, and would make the
  development path differ from production in *guarantee* rather than in scale.
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
  module directories, their `.changes/ledger.yaml` entries, the `workflow-temporal/nodejs`
  workspace entry, the Workflow topology doc, its `pages/sidebars.ts` entry and the
  reference in `kernel/docs/topology.md`. Both are published (0.5.1 and 0.6.2), so their
  ledger entries record layer digests for artifacts nothing will build again — a stale
  entry the moment the directories go, and the reconciliation `telo release verify`
  cannot perform for a module the workspace scan no longer discovers. The workflow canvas
  that doc describes was never built, so no editor code is affected. **No release
  fragment is filed for either** — `Removed` is a major-inducing kind that
  `telo release check` rejects, and a module that no longer exists has no version to
  move.

## Complete example — the local backend

```yaml
kind: Telo.Application
metadata:
  name: Onboarding
imports:
  Durable: oci://ghcr.io/telorun/durable@0.1.0
  Local: oci://ghcr.io/telorun/durable-local@0.1.0
  JournalPg: oci://ghcr.io/telorun/durable-journal-postgres@0.1.0
  # Sql + its backend and the mail module elided with the resources that use them
targets:
  - !ref resumer
---
# extends Durable.Run (the marker abstract) — holds the body, provides the zone.
# `steps:` is native (x-telo-steps), so there is no second document.
kind: Local.Workflow
metadata:
  name: onboard
journal: !ref runJournal
# Idempotent start: submitting the same email twice attaches to the live run
# instead of onboarding twice. Omit runId to have one minted.
runId: !cel "'onboard:' + inputs.email"
onConflict: attach
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
# extends DurableLocal.Journal — this backend's storage seam. Postgres rather than
# generic SQL because claiming due runs is FOR UPDATE SKIP LOCKED and waking is NOTIFY.
kind: JournalPg.Journal
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
# What the delivery carries. Per-instance, so downstream steps type-check against it.
outputType:
  type: object
  properties:
    approvedBy: { type: string }
    note: { type: string }
  required: [approvedBy]
  additionalProperties: false
```

`appDb` (a `SqlPostgres.Connection`), `accountTx`'s inner statements and `sendMail` are
ordinary resources, elided here. **`Local.Workflow` carries its own `steps:`** — the
prerequisite makes the grammar built-in, so there is no companion `Run.Sequence` and no
`!ref` from the workflow to its own body. A body that is *not* a step list is still
reachable in one step (`steps: [{ invoke: !ref someScript }]`), which is why the kind
needs one slot rather than two. `Durable.Await` **names nothing** — it reaches the run
handle ambiently and returns a backend-minted token — but it does declare its own
`outputType`, because what a delivery carries is a property of this await and of no
other. Without it, `steps.waitForApproval.result.approvedBy` would type-check against
nothing.

A journal, a resumer and a `runId` policy are **this backend's** vocabulary. The
hosted backends below have none of them, and say so in their own words rather than
implementing an interface that pretends otherwise.

**The journal shares `appDb` with the transaction, and that one shared `!ref` is what
buys exactly-once.** Because the journal's connection is the connection the transaction
opened its zone on, its appends land inside that transaction — so `accountTx`'s inner
steps are journaled individually rather than collapsed, and each write and its entry
commit or roll back together. Point the journal at a different database and nothing
breaks: the attestation fails, the zone collapses to one entry, and you are back to the
at-least-once behaviour with the whole transaction re-running on resume.

`accountTx` is a `Sql.Transaction`, so a crash inside it rolls back its writes *and*
their entries together, and replay re-runs exactly the statements that did not land.
The step's `retry` sits *outside* the zone and retries the transaction whole — a
retry with a suspending delay *inside* the body would be a diagnostic. An HTTP call in
that body would be the exception that proves the scope: not rolled back, so replayed.

`approval` is a `Durable.Await`: the run parks on its token, releases its kernel hold,
and the application may exit. A `Local.Deliver` call carrying that token — from an
HTTP route, days later, in a different process — wakes it; it holds `await: !ref approval`,
so the payload it carries is type-checked against that await's `outputType` rather than
against nothing. The resumer re-enters
`onboard`, which replays: `createAccount` returns its recorded result without
re-running the transaction, and execution continues at `sendWelcome`. The step list
carries **no collapse opt-out** and needs none — nothing wraps it in a
`Durable.Idempotent`, so its steps are journaled individually, which is the default and
the safe direction. Wrapping it would be a written claim that re-running it is a no-op,
and it is not: it would create a second account and send a second email. Moving
`approval` inside `accountTx` would fail `telo check`, printing the transaction zone's
own `Telo.noSuspend` reason.

An HTTP route triggers this by invoking `onboard`, which admits the run, dispatches the
body detached under a fresh cancellation scope, and returns the run id — so the
response goes out while onboarding continues. A route invoking the body directly would
be the failure `telo check` catches — it carries `approval`'s suspension requirement,
and the diagnostic names that path — but with a native `steps:` there is no second
resource to invoke, so the shape is unreachable rather than merely rejected. That is
the quieter win of the prerequisite: the body has no name of its own to misuse.

## The same body on a hosted backend

Both manifests below run **the same `steps:` block, `accountTx`, `approval` and
`sendMail`** as above, verbatim — the steps are elided rather than repeated, which is
the claim being demonstrated: the body is portable, and nothing around it pretends to
be. Every doc that *is* shown is written in its engine's own vocabulary, including the
ones with no counterpart in the other two. (Field names are illustrative; each backend
module designs its own schema.)

### Restate — the engine pushes over HTTP

```yaml
kind: Telo.Application
metadata:
  name: Onboarding
imports:
  Durable: oci://ghcr.io/telorun/durable@0.1.0
  Restate: oci://ghcr.io/telorun/restate@0.1.0
  Http: oci://ghcr.io/telorun/http-server@0.9.0
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
steps: [...]                        # verbatim from the local example
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
steps: [...]                        # verbatim from the local example
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

**Temporal's sandbox is the sharp edge, and purity was never the whole of it.** A
workflow isolate is not merely required to be deterministic; it performs **no I/O**,
so the earlier answer — "the determinism contract is what a workflow function must
satisfy" — addressed the wrong constraint. Two things carry the weight instead. The
step engine and CEL evaluator run *inside* the isolate, which is sound because
`decide` has made control-flow evaluation a pure function of journaled state — that is
what decision journaling buys beyond correctness. And every effect leaves the isolate
through `step(path, target, inputs)`, which the backend turns into an activity round
trip; the conformance rule then obliges the activity side to dispatch through its own
invocation chokepoint, so contracts, tracing and zones hold there exactly as in
process.

**What remains unvalidated, stated rather than glossed:** nobody has yet built a Telo
step engine inside a Temporal workflow isolate, and the seam is shaped by the axis
being real rather than by that experiment having succeeded. If it turns out the isolate
cannot host the engine at all, what changes is Temporal's status as a backend — not
the seam, which a remote-execution backend of any kind would need identically.

### Where the line falls

**Portable — identical bytes on every backend:**

- the step list itself: sequences, branches, loops, and iteration and projection with
  `concurrency` — including branch-level parking, which is a property of the key scheme
  and so behaves identically everywhere. (`Run.Detach` stays portable Telo, but is a
  diagnostic *inside* a durable body; the nested durable run replaces it.);
- `Durable.Sleep`, `Durable.Await`, `Durable.Value`, `Durable.Idempotent`;
- transactions, leases and idempotency claims, and the `Telo.atomic` /
  `Telo.idempotent` / `Telo.noSuspend` zone attributes that govern them — including
  which regions collapse, since that is now derived from a declared property rather
  than chosen at a call site;
- step `retry` with backoff, `nonRetryable` and `timeout`, because retry lives in the
  step engine;
- the journaled decisions themselves — a run's replay-closed state has the same shape
  on every backend, which is what makes the closure property a property of Telo rather
  than of one journal;
- every static check — `DURABLE_NONDETERMINISM` (`Telo.idempotent` regions),
  `Telo.noSuspend` containment, the detached-dispatch and suspending-retry rules, and
  the `outputType` warning.

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

## Sequencing

Seven slices, ordered so that **each one puts the previous under load rather than
merely adding to it**, and sized so that **nothing normative is frozen before something
exercises it**. Two rules produced this shape. Work with standalone value and no
dependency on durability ships on its own rather than riding along. And the spec is
written in the same slice as the backend that first makes its format cross a process
boundary — a normative document expected to move is not one.

### 1 — zone attributes and the containment walk

`Telo.ZoneAttribute`, the registry, alias resolution, `dependentRequired` composition,
`validate-zone-slots` extensions and the `ZONE_ATTRIBUTE_*` diagnostics; the analyzer's
containment walk; `Telo.atomic` / `Telo.noSuspend` declared on `Sql.Transaction.steps`,
`Lease.Critical.invoke` and `Idempotency.Once.invoke`, with the latter two becoming zone
providers and gaining their `withZone` calls. Also the `workflow` / `workflow-temporal`
removal, which depends on nothing.

Sliced out first because it is the largest analyzer change in the plan and it stands
alone: nothing here mentions a journal, and the registry is generically useful the day
it lands. Reviewing it against durability's noise would be the expensive way to do it.

### 2 — retry parity

**The attempt loop has already landed**, in the SDK's step leaf: `attempts`,
`initialDelay`, `factor`, `maxDelay` and `jitter`, consumed at the leaf so every
dispatch branch reads them. What this slice adds is the parity the hosted engines need —
`nonRetryable` classification and a step `timeout:`. Independent value, no durability
dependency, no reason to wait behind a spec. Deferred to slice 3 is a *suspending*
backoff, which needs a suspension to exist, and to slice 4 the attempt-state journaling
that keeps a bounded policy bounded across a resume.

### 3 — the seam, the spec, and `durable-journal-file` together

The `durable` member on `InvokeContext`, the run-handle interface in `@telorun/sdk`,
`kernel/specs/durable-execution.md` (determinism contract, key scheme, entry format),
the step engine's journaling / `decide` / collapse, `Telo.replayed` and the durable
checks, `durable-local`'s `Workflow` + `Journal` abstract + `Resumer`, and
**`durable-journal-file` in the same slice**.

`step`'s target parameter takes a declaration-site identity here — that is the seam's
shape and it cannot move later — but its **encoding is not specified in this slice**.
Nothing here sends one anywhere: the local backend resolves it in-process, so a
normative encoding would be a format frozen with no consumer, which is the rule below
applied to itself. It is written in slice 7.

The file journal, by contrast, is here rather than after, and that is decisive: the key
scheme and entry format *are* declared normative in this slice, and a format whose only
consumer is an in-process fixture has been frozen without being tested. Landing the
simplest durable store alongside means the format survives a real restart at the moment
it is written, and what fails is the format rather than a database driver. This is the
first slice that demonstrates the property the feature exists for.

Suspension is deliberately **not** here: a run that cannot park can still crash and
resume, which is the whole of what this slice must prove.

### 4 — suspension and the addressing kinds

`Durable.Sleep`, `Durable.Await` (with its `outputType:`) and `Durable.Value`; the
suspension signal, its latch and `ERR_DURABLE_SUSPENSION_SWALLOWED`; branch-level
parking under `concurrency`; suspending retry backoff and its journaled attempt state;
`Telo.noSuspend` enforcement; and `durable-local`'s `Deliver` — taking the `await:` ref
whose `outputType` types its payload — plus `Status`, `Result`, `Cancel`, `Schedule` and
`Resume`.

Separate from slice 3 because suspension is the harder half — the latch, the swallow
surface and the settle-all-branches semantics are where the subtle failures live, and
they are much easier to reason about against a crash-recovery path already known to
work.

### 5 — `durable-journal-postgres`

Two things at once. Concurrency: `FOR UPDATE SKIP LOCKED` claiming, advisory locks,
`LISTEN`/`NOTIFY` wakeups, several resumers against one journal. Slice 3 proved the
format; this proves the protocol under contention, which a single-process file journal
cannot.

And **exactly-once**, because this is the first journal that can share a transaction
with the writes it records. Concretely: the journal answers `writesInside(zone)` with
the connection's existing `hasOpenTransaction()`, and the step engine stops collapsing
atomic zones when it does. Nothing in `modules/sql` changes — the executor already
resolves an undeclared statement onto the ambient zone's transaction. The conditional
collapse is written in slice 3 with the attestation permanently false (the file journal
answers no), so this slice turns on a path that already exists rather than adding one.

### 6 — `modules/restate`

The first backend the app does not drive. It attacks the parts slices 1–5 could not:
re-entry from an inbound route, the `rootContext()` construction, parking as a protocol
frame rather than a stored wake time, out-of-band delivery through the ingress, and a
run identity that is someone else's key. If the seam is wrong about who owns the
lifecycle, it fails here — which is why Restate comes before Temporal despite being the
younger engine.

### 7 — `modules/temporal`

The only slice that exercises **remote step execution**, and therefore the only one that
tests the half of `step(path, target, inputs)` that motivated it: the zone-based
locality rule, and the step engine running somewhere the resource graph does not. **This
is where the target-identity encoding is written into
`kernel/specs/durable-execution.md`** — the three forms sketched above, normative
because this is the slice where one crosses a process boundary and a second runtime must
derive the same string. Last because it is the largest unknown — nobody has yet built a
Telo step engine inside a workflow isolate — and because a failure here should be able
to invalidate *Temporal as a backend* without invalidating anything shipped in slices
1–6, which is exactly what deferring the encoding to here protects.

**What the order buys.** Every slice ships on its own, and the first two deliver value
with no durability in them at all. Nothing before slice 6 depends on a hosted engine
existing. Nothing normative is written before the slice that exercises it. And nothing
in 6–7 requires reopening the seam if the earlier slices were right — which is the claim
the ordering exists to test early and cheaply rather than discover late.
