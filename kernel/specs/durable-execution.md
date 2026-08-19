<!--
Normative. Two runtimes that guessed differently here would not merely accept
different manifests — they would corrupt durable state, because a journal
outlives the process that wrote it and is read back by whatever is running then.
-->

# Telo Durable Execution Specification (v1.1)

## 0. Status, scope, and how to read this

This specification covers **the kernel's half** of durable execution and the
**replay contract** every step engine must satisfy. It deliberately does not
specify a durable-execution *engine*: there is no shared lifecycle vocabulary,
no shared start/schedule/cancel surface, and no portable `Durable.*` driver.
Each backend ships its own module in its own words.

What is normative here is only what two runtimes must agree on:

1. how the run handle is carried and what must not clear it (§2, §3);
2. the **replay determinism contract** the step engine is bound by (§4);
3. the **key scheme and entry format** for a backend that keys by path (§5);
4. what a journaled value may be (§6);
5. the conformance requirements every backend keeps (§7).

MUST / MUST NOT / SHOULD are as in RFC 2119.

**v1.1 adds suspension**: `park`, the swallow latch, branch-level parking under
concurrency and suspending retry (§2, §5.2, §7, §9). v1.0 specified a run that
could crash and resume but not wait; a run that can wait is what makes durable
execution useful for work measured in days rather than in retries.

## 1. What durable execution is here

Durable execution is **journal plus deterministic replay**. Telo can have it
because of a property that fell out of the step grammar's design: control flow is
a finite, DECLARED set of CEL expressions over run state, not arbitrary code. So
replay is re-running the step list while returning recorded values instead of
computing them. There is no continuation capture, and there MUST NOT be — a
mechanism that captured a continuation would be capturing one runtime's stack.

This is a structural advantage Telo has and hosted engines do not. Temporal and
Restate rely on determinism discipline plus divergence detection precisely
because their workflow bodies are arbitrary code with no finite set of decision
points; you cannot journal "the decisions" of a `while` loop in TypeScript
without instrumenting the language.

## 2. The run handle

A **run handle** is the object a step engine journals through. Its contract is a
language-level interface in `@telorun/sdk` (`DurableRunHandle`), not a resource
kind and not a kernel type:

- **`step(path, target, inputs, execute)`** — hand over an effect. The backend
  decides *whether* (replay returns the recorded result) and *where* (in process
  now, or shipped elsewhere and awaited).
- **`decide(path, kind, compute)`** — a control-flow decision, recorded on first
  execution and returned verbatim on replay.
- **`park(where, until)`** — suspend the run, recording WHERE it parked. A
  backend MUST write the park before it unwinds: the signal only unwinds the
  calling process's stack, so a park that threw first leaves a run marked
  running with nothing executing it, and its wake token lost. (§7.)
- **`writesInside(zone)`** — a *question*: does this handle's own recording land
  inside the given zone's atomicity? (§8.)

**Why `step` and not lookup-plus-record.** The obvious factoring — *have you a
result at this key* / *record this one* — is a leaky decomposition: two halves of
a single operation, split so that the CALLER performs the effect in between. That
bakes in an assumption nothing stated, that the step engine and the resource
graph are co-located. But *where an effect executes* is a real architectural
axis: orchestration is deterministic and cheap, effects are neither, and
separating them is what lets a system scale, version and retry them
independently. A seam that hardcodes in-process chooses one side of that axis
permanently.

`execute` is therefore the *local capability* the backend may use, not a caller
that runs the effect between two halves.

**The kernel is a pure conduit.** It carries the handle and MUST NOT call it. A
runtime therefore needs no durable contract of its own, and a backend is an
ordinary module.

## 3. Carriage

**The handle MUST be reachable from nested dispatches, and so MUST the path of
the step that dispatched them; how is the runtime's choice.** That is the whole
normative statement. The Node kernel satisfies it by putting both on
`InvokeContext` beside `zones` and letting the existing ambient store carry them;
a runtime with no ambient mechanism threads them explicitly.

Two things travel, not one, and the second is easy to miss because a backend that
matches by ORDER never reads it. A path-keyed backend does, and a nested body that
never received the enclosing path keys its records as though it were the only body
in the run (§5.1).

**It is its own member, not a zone-entry payload.** The durable zone IS a real
zone and rides the landed stack, but a `ZoneEntry` is three identities *because*
that keeps it ABI-serializable and stops any controller reading another module's
open state off the stack. A live object with methods on the entry would trade
that property away for every zone, durable or not — and the payload rule
(provider-private state lives on an instance injected across the boundary) cannot
carry it either, since a nested step body holds no durable reference and has no
injected instance to read from.

The consequence is stated rather than implied: **unlike `zones`, the handle does
NOT cross the ABI.** A second runtime threads a handle it owns.

**Every context rebuild MUST go through the runtime's single derive function.** A
fresh object literal at a rebuild site drops whatever it does not restate, which
for this member means durability that is present with tracing off and absent
under a debug flag.

**Clearing follows the zone rules unchanged.** A detached dispatch and an inbound
trigger's `rootContext()` both replace the ambient with a root that carries no
handle — which is correct, and is what makes a nested durable run a *new* run
rather than a continuation of its parent.

## 4. The replay determinism contract (normative)

> On replay, a step engine MUST reach the same steps, in the same order, against
> the same targets, with the same collapse decisions, as the execution the
> journal records.

It is **discharged by construction**, not by discipline: every value that could
make the engine reach a different step is journaled through `decide`. Stating it
as a contract rather than relying on it as an assumption is what lets a backend
that matches replayed frames against re-issued calls assert something real.

**Every decision point MUST be journaled.** The set is closed by the grammar, and
for v1.1 it is exactly:

| Decision | Journaled as |
| --- | --- |
| a step's resolved `inputs` | `inputs` |
| an `if` / `elseif` predicate, a `when` guard | `predicate` |
| a `while` condition, per turn | `condition` |
| a `switch` key | `switch` |
| a `value:` step's expression | `value` |
| a park's wake time, token, or retry attempt | `value` |
| a collection a composer iterates | `collection` |

**The tempting claim — "a run's entire mutable state is the `steps` map" — is
FALSE, and this is the load-bearing paragraph of the whole specification.** The
CEL scope those expressions evaluate against also carries `resources.<name>`
snapshots, `resources.<name>.status` (a live reading, republished on every
dispatch *by design*), provider values, variables and secrets. Re-evaluating any
of them in a fresh process against freshly-created resources can yield a
different answer, and the sharpest case is silent: an iteration whose collection
comes from a resource read returns a different order on resume, index N now names
a different element, and the journal hands back the recorded result for that path
— with the same target, so no mismatch is detectable. Wrong results, no error,
which is the precise failure durability exists to prevent.

**A digest-and-detect scheme MUST NOT be substituted.** It is equally closed for
*detection* and much cheaper, and it is wrong: observed state is *defined* as a
live reading, so a run would fail on every resume where the world had moved,
which it usually has. That is fragility with good error messages, not durability.
Recording the value removes the failure instead of reporting it.

Replay is then a pure function of `(journal, manifest)` — a **closure property**,
and closure is what makes this survive: an ambient value source added years from
now (a new scope variable, a new binding form, a new provider kind) is covered
without anyone re-auditing a list.

## 5. The key scheme and entry format

This section binds any backend that **keys by path**. A backend that assigns its
own indices (both hosted engines do) satisfies §4 instead, which is what makes
order-based matching sound.

### 5.1 A step path

A path is `/`-joined segments; a repetition qualifies its segment with `[index]`.

```
steps/createAccount
steps/checkStock/if
steps/checkStock/then/reserve
steps/poll/while[3]
steps/poll/do[3]/fetch
steps/importAll/cases/bulk/write
```

Both the segments and the indices are properties of the **written structure plus
the run's own journaled decisions**, never of wall-clock order. This is what
makes the scheme survive concurrency, where a per-run call ordinal would not: two
branches of a fan-out interleave their dispatches, so an ordinal numbers them
differently on every run while these paths stay fixed. It is also what makes each
branch of a fan-out an **independently resumable subtree**.

**A NESTED body's paths hang under the step that dispatched it.** A step body is
not only found at the top of a run: a step may dispatch a target that has a body
of its own, and that body's engine MUST continue the enclosing path rather than
start again at `steps`.

```
steps/charge                     ← the step
steps/charge/announce            ← a step of the body it dispatched
steps/charge/work
```

This is normative because getting it wrong is silent and is wrong on the FIRST
run, not merely on a resume. A nested engine that restarted at the root would
record `steps/<name>` for every body in the run, so two nested bodies with a
same-named step share one key; the first record wins, and the second body's step
is handed the first's RESULT without executing. Where both dispatch the same
target there is no mismatch to detect (§5.3) and nothing reports it.

It is also what makes a nested body independently resumable: an interruption
inside one resumes at the step of it that had not finished, rather than re-running
the whole body.

**How the enclosing path reaches the nested engine is the runtime's choice**, and
the requirement is only that it does. The Node kernel carries it on
`InvokeContext` beside the run handle, so a composer that knows nothing about
durability — an ordinary sequence — passes it along with the context it already
threads. A runtime with no ambient mechanism threads it explicitly, exactly as it
threads the handle.

A path is composed by the runtime's shared helper (`stepPath` in
`@telorun/sdk`). A backend MUST NOT compose one itself: a journal outlives the
process that wrote it, so two step engines keying differently produce one neither
can replay.

**What a path-keyed backend treats as a change, an order-matched one does not.**
Renaming a step, or moving one into a nested body, leaves the ORDER of dispatches
identical while changing the key — so the edit is invisible to a backend
satisfying §4 by order, and causes that step to execute afresh on a backend keyed
by path. Neither is wrong; they are the two matching strategies this section
deliberately permits, and the difference is a property of the backend rather than
of the manifest. An author moving steps under a live run should expect the
path-keyed backend to re-run what it can no longer find.

### 5.2 Entries

Three entry shapes. A backend MAY store them however it likes; what is normative
is that these fields exist and mean this.

**A step entry** — written on COMPLETION, never on dispatch:

```yaml
path: steps/createAccount
kind: step
target: { kind: Sql.Transaction, name: accountTx }   # §5.3
result: { id: 41 }
```

**A decision entry**:

```yaml
path: steps/checkStock/if
kind: decision
decision: predicate
value: true
```

**A run record**:

```yaml
run: "onboard:ada@example.com"
manifestDigest: sha256-9f2c…
digestScope: reachable        # `reachable` | `manifest`
status: running               # scheduled | running | parked | completed | failed | cancelled
parked:                       # present while `status: parked`
  path: steps/waitForApproval # where a resume re-enters, and where a delivery writes
  resource: approval          # what it is waiting on, for an operator
  token: 0f3c…                # the address a delivery must carry
  at: 1787159304535           # when it becomes due with no delivery
```

`cancelled` is deliberately distinct from `failed`: a failed run earned a
verdict, a cancelled one was called off, and collapsing them makes every
cancelled run indistinguishable from a broken one in the report an operator
reads to find out which happened.

**Journal on completion** is the rule the whole format rests on, and it is what
makes `with:` scopes work unchanged: a scope target that completed is skipped on
resume, while a long-lived service whose `run()` stays pending has no entry and
is re-dispatched — which is exactly right after the process holding its listener
died.

### 5.3 Target identity

A step entry records **where its target is declared**, not which live object it
was. Instance identity is process-local by construction (`ResourceHandle.ref` is
declaration-site *diagnostics*, and there is deliberately no reverse
handle→instance mapping), so a recorded instance would be meaningless to the
process that reads the journal back.

The identity has three forms, derivable identically by the analyzer and at
runtime:

- a **module-level** resource — `(module ref, resource name)`; names are dot-free
  by the reference grammar's load-bearing invariant, so the pair is unambiguous;
- a **`with:`-scoped** resource — `(module ref, scope owner, scope site, step
  path, resource name)`. The scope *run* is what makes a scoped instance
  distinct, and inside a durable run a scope run is opened by a step at a
  determined path, so the tuple is deterministic;
- an **inline-declared** target — `(module ref, declaring resource name, JSON
  pointer to the declaration)`. Anonymous in the manifest, not anonymous in the
  graph.

**The ENCODING — how one is written into bytes — is NOT specified in v1.1.**
Nothing in this version sends an identity across a process boundary: a local
backend resolves it in process. It is written in the version that first does, and
freezing a format nothing can exercise is the failure this document's own
sequencing rule exists to prevent.

A replay that reaches a **different target** than the entry at that key records
MUST raise `ERR_JOURNAL_ENTRY_MISMATCH`.

## 6. What may be journaled

A journaled value MUST be serializable. Two consequences:

- **A live value is not journalable.** A `live`-representation value (`x-telo-type`
  with `live: true` — a stream handle today) is consumed by reading, so it exists
  exactly once and a recording of it is a recording of nothing. This holds in
  BOTH positions — a step result and a decision — and a runtime MUST raise
  `ERR_DURABLE_UNJOURNALABLE_VALUE`, **at the step path that produced it**.
- **A declared `outputType` is better but not required.** Demanding one on every
  journaled step's target does not prove what it advertises — the contract
  resolver's layers mean a declared `{type: object, additionalProperties: true}`
  satisfies such a check and proves nothing, while an *undeclared* contract falls
  back to the same permissive shape. So the runtime is the gate and the static
  half is a warning. This is the *enforced at runtime, warned early* division
  applied to the same kind of problem as containment.

## 7. Conformance requirements

Every backend, whatever its vocabulary:

1. **Admit before executing.** A start that executes before it is durably
   recorded is unrecoverable if the process dies in between; recording first is
   what lets recovery find a run with no progress and replay it. This is a
   conformance requirement rather than a contract method, because there is no
   shared contract to put it on.
2. **Dispatch through your own chokepoint.** Wherever a step executes, the
   executing side MUST dispatch through that runtime's invocation chokepoint, so
   the invocation contract, tracing, zones and observed state hold identically. A
   backend may move *where* a step executes; it MUST NOT move it outside the
   runtime's dispatch.
3. **A body starts outside every enclosing zone.** A run outlives whatever
   triggered it, so no enclosing zone's lifetime may reach its body. A backend
   that dispatches its body detached gets this from the detach primitive; one
   re-entered from an inbound trigger gets it from the inbound obligation. The
   workflow kind then layers its own zone and the run handle onto that root.
4. **Declare `replayed`.** A backend's workflow kind MUST carry
   `x-telo-provides-zone` with the `replayed` attribute on the slot holding the
   body, and MUST extend the marker abstract the parking kinds require. One
   without the other yields either parking kinds no zone satisfies, or a durable
   zone the static checks never look inside.
5. **Locality is decided by zones.** A step whose dispatch sits inside any open
   zone *other than the durable zone itself* MUST execute locally. A zone is
   ambient process state (an open transaction, a held lease) and a remote
   executor would have none of it — which the payload rule already says must fail
   loudly rather than silently run unzoned. One rule, covering every case a
   hand-written exception list would try to enumerate.
6. **A detached dispatch inside a replayed zone is forbidden.** Journal-on-
   completion would record the *dispatch* as done while the work runs on, so a
   resume skips it and a crash loses it — durability's exact inverse. The
   replacement is a nested durable run started without awaiting, whose run id is
   itself a journalable value.
7. **A suspension is a signal, not an error, and it MUST NOT be absorbed.** It
   unwinds to the workflow that owns the run, so a `try:` step, a composer's
   `catches:` and a retry policy MUST all let it pass — and a runtime's own
   dispatch chokepoint MUST NOT wrap it, since every hop between the parking kind
   and the workflow goes through one.

   **Naming the known absorbers is not a defence.** The signal passes through
   every controller in between, including third-party ones with a `catch (e)` in
   them; a swallowed suspension converts a park into a completed step and
   duplicates every effect after it, and a pure-conduit kernel cannot see that
   happen. So it MUST be **latched** when raised, and a workflow kind MUST treat
   *an invocation that returned normally while a suspension is latched* as
   `ERR_DURABLE_SUSPENSION_SWALLOWED`, **before** settling the run. Detection is
   O(1) and needs no cooperation from the absorber.
8. **Parking inside a concurrent region parks the BRANCH.** A fan-out settles
   every branch — resolved, rejected, or parked — and propagates the suspension
   only once all of them have. Unwinding on the first park tears its siblings
   down mid-step, and because a step is journaled on completion they have no
   entry: every one re-runs whole on resume, making parallel fan-out routinely
   at-least-once. The semantics need no new machinery, because a branch's step
   paths are already index-qualified and each branch is therefore an
   independently resumable subtree.
9. **A suspending retry MUST journal its attempt state.** A backoff long enough
   to park records which attempt it was on and when the next is due; without it a
   run that parks mid-retry and resumes elsewhere restarts the policy from zero
   and a bounded budget becomes unbounded. A backoff short enough to sleep in
   process still journals only the outcome.

## 8. Collapse, and exactly-once

### 8.1 The rule

> A region collapses to one entry when **re-running it is safe** — because its
> effects are discarded together, or because re-running is a no-op.

Collapse is derived from a declared **zone attribute** (`kernel/specs/execution-zones.md`
§4.1.1), never from a field at a call site:

- **`idempotent`** — collapse, full stop. There is nothing for the journal to be
  inside, and re-running is a no-op either way.
- **`atomic`** — collapse **unless** the run handle attests via `writesInside`
  that its own entries land inside that zone's atomicity.

Everything is journaled by default; collapse is opt-in and visible, because a
region is wrapped by a kind that declares the property with a written reason.
Forgetting to journal an effectful step re-executes it on replay, which is the
failure nobody notices, so the opposite polarity would put the burden on the
cheap case.

**Collapse suppresses per-step entries, not the journal.** A direct `decide` — a
resource inside the region pinning an impure evaluation — still records, which is
what lets such a resource work inside a collapsed region rather than be a
prescription with nowhere to write.

### 8.2 Why `atomic` is conditional

A collapsed atomic zone is **at-least-once**: the whole zone re-runs on resume,
because a crash between COMMIT and the journal write leaves work done and
unrecorded. That is unavoidable *only while the journal is somewhere else*. When
the journal writes into the very transaction whose effects it records, COMMIT is
atomic over both and the window closes: either the write and its entry both land
or neither does.

So the conditional is not an override of the attribute; it is the attribute read
correctly. `atomic` says *effects inside are discarded together*, and collapse
follows only when the journal's own writes are **not** among them. When they are,
per-step journaling is consistent by construction and strictly better: finer
replay granularity, and no re-running a committed transaction.

The outer step — the one whose target *is* the atomic region — records after
COMMIT, so its own window stays open; it is harmless. A crash there replays the
step, which re-invokes the region; every inner step returns its recorded result
instead of executing, the transaction commits empty, and the outer entry is
written. No duplicate effect, at the cost of one empty transaction.

**What stays at-least-once, stated precisely:** a non-transactional effect inside
a transactional zone. An HTTP call in a transaction body is not rolled back while
its journal entry is, so replay repeats it. Exactly-once is a property of
*effects in the same database as the journal*, not of durable execution in
general.

### 8.3 It MUST be reported

Which regime a deployment got turns on whether the journal's connection *is* the
transaction's connection at runtime — invisible in the manifest, and silently
degrading if someone repoints it. A runtime MUST therefore make the resolution
observable: a structured record per atomic region at the moment collapse is
resolved, and a per-run count of collapsed regions as observed state. A
durability feature whose guarantee is decided by an invisible runtime coincidence
has to say which way it resolved.

## 9. Error codes

| Code | Raised when |
| --- | --- |
| `ERR_DURABLE_UNJOURNALABLE_VALUE` | a step result or decision cannot be serialized, at the step path that produced it |
| `ERR_JOURNAL_ENTRY_MISMATCH` | replay reaches a different target than the entry at that key records |
| `ERR_DURABLE_MANIFEST_CHANGED` | a resume would replay against changed code (backend-specific; see the backend's own docs) |
| `ERR_DURABLE_NO_RUN` | a kind requiring a durable run was dispatched with no handle ambient |
| `ERR_DURABLE_SUSPENDED` | not an error — the suspension SIGNAL, carried on an `Error` so it unwinds. It MUST reach the workflow that owns the run |
| `ERR_DURABLE_SUSPENSION_SWALLOWED` | a body returned normally while a suspension was latched (§7) |
| `ERR_DURABLE_SUSPEND_FORBIDDEN` | a park was attempted inside a zone declaring `noSuspend`, quoting that zone's own reason |

## 10. What v1.1 deliberately leaves out

- **The target-identity encoding** (§5.3), until something sends one across a
  process boundary.
- **Remote step execution**, for the same reason.
- **Any shared start / schedule / cancel / status surface.** There is none, by
  design: those are where engines genuinely differ, and flattening them costs
  fidelity in both directions.
