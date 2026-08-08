# Durable execution

**Depends on `plans/execution-zones.md`** for the provide/require annotations and
their satisfaction walk. This plan adds the journal and replay machinery, and the
*exclusion* half of that annotation family, which the zones plan deliberately
leaves out.

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
leaves Telo with no durability of its own on a plain Postgres. Both are removed.

## Solution

Durable execution is **journal plus deterministic replay**, and Telo can have it
cheaply because of a property that fell out of `Run.Sequence`'s design: a run's
entire mutable state is the `steps` map, and control flow is re-derived from pure
CEL over it. So replay is re-running the step list while returning recorded
results instead of dispatching. No continuation capture.

**The journal is a module abstract; the kernel only carries the handle.**
`modules/durable` owns a **`Durable.Journal`** abstract — first-writer-wins entry
append, ordered read, the run record (status, wake time, manifest digest, claim) and a
due-runs query — with `durable-journal-sql` over `Sql.Connection` (so Postgres and
SQLite both) and `durable-journal-memory` for development extending it: the
`sql`/`sql-postgres`, `kv-store`/`kv-store-*` shape. It lives beside the executor kinds
rather than in a module of its own because a separate `modules/journal` would put a
second, unrelated `Journal` namespace next to `record-stream`'s existing `Journal` /
`JournalSink` / `JournalSource` (an in-memory stream replay buffer) — competing for the
obvious import alias and for hub search on the word, for a module only `Durable.Run` and
`Durable.Resumer` ever reference. The kernel is a **pure conduit** — it carries the
handle and never calls it, so it needs no contract of its own.
`kernel/specs/durable-execution.md` therefore covers only the kernel's half:
handle propagation on `InvokeContext`, the suspension signal and what must not
swallow it, hold release. The step engine consumes the handle through a TypeScript
interface in `@telorun/sdk` — the split logging already makes between `Logger` /
`RecordBuffer` and the `Telo.LogSink` abstract.

**The handle must be reachable from nested dispatches; how is the runtime's choice.**
That is the normative statement — the Node kernel satisfies it by putting the journal
handle and current step path on `InvokeContext` and letting the existing
`AsyncLocalStorage` carry both, but a runtime with no ambient mechanism (the Rust
kernel's `invoke_dispatch` is synchronous and takes no context) may thread it
explicitly. The spec constrains reachability, never the mechanism. The carrier is the
ambient zone state the execution-zones plan makes kernel-owned — the durable zone
is one more entry on that stack, its journal handle the entry's payload — so the two
plans add one mechanism, not two. This is what makes nesting work
without per-module effort: a nested `Run.Sequence` — in the same module or reached
across an import boundary — picks the handle up and journals its steps under the
outer step's path, so a crash inside it resumes inside it. A composer that offers
no deterministic key (an `Ai.Agent` tool loop, whose sequence the model chooses)
becomes a single entry, which is the correct semantic there.

**Journaling lives in `run`'s step engine**, because a step path is the only
naturally deterministic key available, and it survives concurrency where a call
ordinal would not. `run` gains no dependency: the journal is reached through the
ambient handle, never named in its schemas, so the module stays import-free.

**The key scheme and entry format are normative, not an engine implementation detail.**
A journal outlives the process that wrote it, so the worker that resumes a run need not
be the one that started it — and two step engines deriving step keys differently produce
a journal neither can replay. That is the same argument
`kernel/specs/invocation-contract.md` makes for itself ("two runtimes that guess
differently would accept different manifests"), except the failure here corrupts durable
state instead of rejecting a manifest. So the spec pins how a step path is composed, how
loop and branch counters enter it, and the on-disk shape of an entry and a run record.
It is also why a journaled step must declare `outputType`: the contract is not only what
makes journalability provable, it is the serialization boundary another runtime reads the
entry through.

**The durable zone, and containment, come from the zone mechanism.**
`Durable.Run.invoke` carries the *providing* annotation on a slot whose `use` is
`detached` (the typed-reference-graph vocabulary): the start is dispatch-detached
through the kernel primitive, which clears the zone stack as a guarantee. It
establishes the durable zone and ends every
other — a run outlives whatever triggered it, so no
enclosing zone's lifetime reaches its body. A transaction requirement arriving there
fails — and because zone state is kernel-owned, the detach sheds the enclosing
transaction zone deterministically instead of racing its commit. `Durable.Sleep`
and `Durable.Await` carry the *requiring* annotation, type-scoped against
`Durable.Run`. The
analyzer derives the durable zone by walking `call` edges of the shared graph from any
providing field — never naming `Durable.Run`, which would be the hardcoded kind
knowledge the topology constraint forbids — so nothing is marked durable by hand and a
nested sequence cannot be forgotten.

Containment follows the same division the zones plan sets: **enforced at runtime,
warned early.** `Durable.Sleep` and `Durable.Await` raise when no journal handle is
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

**New kinds in `modules/durable`.** `Durable.Run` owns run lifecycle — mints the
run id, claims the run through `KeyedClaim`, drives replay, handles suspension —
and holds the `journal:` reference to a `Durable.Journal` implementation. It returns a
run id rather than awaiting, because an awaited
call cannot survive a suspend; a separate wait verb blocks when a caller does want
to. `Durable.Sleep` and `Durable.Await` persist a wake time or park for an external
event and unwind; `Durable.Deliver` wakes a parked run. `Durable.Value` journals one
impure evaluation. `Durable.Resumer` is a service that polls for due runs and
replays them, claiming per run — no leader election, since a per-run claim is
finer-grained and sufficient.

**A start is dispatch-detached, with the run recorded first.** `Durable.Run` writes
the run record, then dispatches the body without awaiting it and returns the run id
— so an HTTP route that triggers a run responds immediately while the body keeps
going. Recording before dispatching is what makes a crash in between recoverable:
the resumer finds a run with no progress and replays it. Two consequences the detach
forces. The body must run under a **fresh cancellation scope**, because `runInvoke`
inherits the ambient token and the run would otherwise be cancelled the moment the
triggering request completed. And a body that is *running* holds the kernel (via the
existing detached-task tracking) so the application cannot exit mid-run — it is only
the *suspended* state that releases the hold. The trade-off worth recording: the
process that receives the trigger performs the initial execution, so starts are not
balanced across workers; the resumer is the recovery and wake path, not the
scheduler.

**Suspension is a distinct signal, not an error.** It unwinds the stack, so a
`try:` step must not catch it and `toSequenceError` must not absorb it.

**Retry moves into the step engine.** `retry:` on an invoke step is currently a
no-op: `executeInvokeStep` passes it as a fourth argument that
`ResourceContext.invoke`'s three-parameter signature silently drops, and nothing
in the kernel reads it. The engine takes the attempt loop, so the chokepoint grows
no policy, each attempt gets its own span, and a long retry delay can suspend
instead of holding the process. Only the final outcome is journaled.

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
sleeps, so on resume another holder may already be running. Exclusion is therefore a
distinct relation, and it is why the zones plan omits it: the forbidding module
would have to name the forbidden effect's module, inverting the dependency direction
that keeps provide/require free of one.

A transaction is the sharp case, and the failure is silent. If a journal entry is
written for a statement and the process dies before `COMMIT`, the database rolls the
statement back while the journal still records success. Replay then skips it, the
transaction commits empty, and the run reports success over writes that never
landed. Nothing detects it.

Two exclusions, declared as annotations on the field holding the body, each carrying
a **required** `reason` string that diagnostics print verbatim:

- **`x-telo-atomic`** — effects inside are discarded together on failure. Forces
  checkpoint collapse: the whole zone is one journal entry, so a resume re-runs it
  entire.
- **`x-telo-no-suspend`** — the zone holds something bounded that a parked run
  would lose. Journaling granularity is unaffected.

Three shipped consumers, in two distinct combinations: `Sql.Transaction.steps`
declares both; `Lease.Critical.invoke` and `Idempotency.Once.invoke` declare only
`x-telo-no-suspend`, since their effects genuinely commit and should be journaled
individually.

Annotations resolve along `extends`, so an additive child inherits through schema
merge; a `base:`-narrowing child, whose author-facing schema is its own only, is
treated as **wholly** in-zone — conservative, and it avoids tracing which child
field feeds the parent's body through `base:` CEL. The runtime half mirrors
`x-telo-scope`: the schema marks the field, and the declaring controller runs its
body through a zone call on the ambient journal handle, so `modules/sql`,
`modules/lease` and `modules/idempotency` each gain an annotation *and* a controller
change, and the SDK gains the zone call.

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

From `x-telo-no-suspend`: any target in the zone carrying a suspension
requirement. That is one rule rather than an enumeration of forbidden kinds, so a
suspension kind added later is covered without touching the check. Two step-level
checks stay separate, being properties of the step rather than of its target: a
retry whose delay would suspend, and a **detached dispatch**. The latter keys off
the dispatch being detached rather than off `Run.Detach` as a kind, so it also
covers `Lease.Critical`'s `detach: true` — either way the journal would record a
completion for work that has not run.

From `x-telo-atomic`: a body declaring `requireCheckpoints: true` inside the zone,
a direct contradiction (the callee demands per-step entries, the zone forbids
them), reported naming both sites. Plus a completeness check — `x-telo-atomic`
without `x-telo-no-suspend` on the same field is an error.

The exclusion checks extend the zones plan's single parameterized walk rather than
adding passes of their own.

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

Long runs are bounded by **compaction**, affordable for the same reason replay is:
the whole run state is the serializable `steps` map, so crossing an entry threshold
records one baseline and truncates, with no replay from zero. Completed runs are
retained for a configured window, then purged.

## Decisions

- **The journal abstract lives in `modules/durable`, not the kernel and not its own
  module** — the kernel carries the handle without ever calling it, so it needs no
  contract; and what justified a kernel-owned `Telo.LogSink` (every controller logs, plus
  a conformance requirement) has no analogue. `run` is kept storage-free by the ambient
  handle, not by where the abstract lives. Rejected: a kernel-owned `Telo.Journal` (the
  "declare a slot without an import" argument justifies `Telo.JsonSchema` because *every*
  kind declares a contract, whereas exactly two kinds declare a journal slot); and a
  standalone `modules/journal`, which would collide with `record-stream`'s existing
  `Journal` kinds on name, alias and hub search while adding a module boundary nothing
  crosses.
- **Journaling in the step engine, not at the kernel chokepoint** — a step path is
  deterministic under concurrency; a per-run call ordinal is not, and a kernel-level
  journal would make "is this call journaled?" invisible to `telo check` and the
  editor. Rejected: ambient journaling of every dispatch.
- **A dedicated journal contract, not `KvStore.Store`** — "which runs are due to
  wake" is a range query, and `KvStore.Store` is deliberately point-access only;
  widening it would weaken a contract four modules already depend on. Rejected:
  `(runId, seq)` keys over the existing KV backends.
- **Suspension containment reuses the zone mechanism rather than a durability-
  specific rule** — a check at the suspension site would catch one shape and leave
  every transitive path open. Rejected: making the zone slot inline-only, which
  would close the hole structurally but forbid sharing any suspension-bearing
  fragment.
- **Containment is enforced at the dispatch, not by the analyzer** — the parking kinds
  raise when no journal is ambient, so an edge the analyzer cannot see fails loudly
  rather than silently. The consequence, recorded rather than glossed: a body reached
  through such an edge runs journal-free steps up to its first parking point, so the
  static check is early warning and not a guarantee that no un-journaled effect ran.
- **The durable zone is derived, hooked by the providing annotation** — declaring
  it per sequence means an author can forget a nested one, and the failure mode is
  silent re-execution. Mirrors runtime reach, which is derived and never declared.
- **A start is dispatch-detached, not enqueue-only** — routing every start through
  the resumer's poll interval would put seconds of latency on a request-triggered
  run for no gain in recovery, since recording the run before dispatch already makes
  an in-between crash recoverable. Rejected: enqueue-only (Temporal's model — more
  uniform and it balances starts across workers, but the latency is not worth it
  here).
- **Everything journaled by default, collapse opt-in** — forgetting to journal an
  effectful step re-executes it on replay, which is the failure nobody notices.
  Opt-out puts the burden on the cheap case instead. Rejected: opt-in per step.
- **Collapse permission belongs to the callee** — the side that knows its own
  effects holds the veto; without it the lever is a footgun whose blast radius is
  invisible at the call site.
- **Exclusions are field annotations, not definition properties** — the analyzer
  needs the location to walk the zone, and a sibling field may legitimately sit
  outside it (an `afterCommit:` hook must run outside the transaction). Rejected: a
  kind-level flag, which cannot say *which* field holds the body without hardcoded
  per-kind knowledge.
- **Two exclusion annotations, not one two-axis container** — one `reason` cannot
  explain two unrelated violations (why per-statement journaling is unsafe and why
  parking is unsafe are different facts), and the `x-telo-*` family is single-concern
  annotations with no omnibus precedent. Rejected: a combined `x-telo-zone`.
- **Atomic implying no-suspend is a completeness check, not a silent default** — the
  implicit form would leave the suspension diagnostic with a generic message, which
  is exactly what the required `reason` exists to prevent.
- **Retry in the step engine, not the kernel** — retry is a composer concern and
  the chokepoint should grow no policy; co-locating it with the journal is what
  lets a long delay suspend rather than block. Rejected: a retry option on
  `runInvoke` (would make the kernel decide what is retryable).
- **`Durable.Run` returns a run id** — an awaited call cannot survive a suspend, so
  awaiting would make suspension unavailable to the common shape. A separate wait
  verb covers callers that want to block.
- **Per-run claims, no leader election** — finer-grained, and `KeyedClaim` already
  implements the protocol both `Lease.Critical` and `Idempotency.Once` use.
- **A moved manifest digest parks the run** — replaying against changed code is
  divergence with no error; auto-branching is a versioning feature, not this one.
- **Journal-inside-the-business-transaction is a follow-up, not shipped** — it is
  the only thing that closes the at-least-once window, and it is reachable here
  since `durable-journal-sql` takes a `Sql.Connection` ref, but "the same connection" is
  a driver-level pooling guarantee that a manifest reference cannot promise.
- **`with:` permitted** — forbidding it would be a prohibition standing in for a
  rule that already covers the case (journal on completion). Its one sharp edge —
  observed state from a re-created scoped resource may differ across resume — is
  documented, since it is the same class as any external state moving between runs.
- **Sagas are out of scope, and depend on this** — compensation needs the journal to
  know which steps completed, so it is a later kind built on top, not an
  alternative. Recorded here because collapse reads like atomicity and is not; a
  third exclusion annotation is where it would land.
- **`workflow` and `workflow-temporal` are removed, not deprecated in place** —
  neither was implemented, and the good idea in them (a pluggable engine) survives
  relocated: the pluggable thing becomes durable *state*, so a Temporal-backed
  `Journal.Store` remains possible while the step grammar stays `run`'s. Published
  versions stay resolvable, so a pinned consumer is unaffected. Removal covers the
  module directories, their `.changie.yaml` projects, the `workflow-temporal/nodejs`
  workspace entry, the Workflow topology doc, its `pages/sidebars.ts` entry and the
  reference in `kernel/docs/topology.md`. The workflow canvas that doc describes was
  never built, so no editor code is affected.

## Complete example after the change

```yaml
kind: Durable.Run
metadata:
  name: onboard
journal: !ref runJournal
invoke: !ref onboardSteps
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
kind: JournalSql.Journal
metadata:
  name: runJournal
connection: !ref appDb
---
kind: Durable.Resumer
metadata:
  name: resumer
journal: !ref runJournal
---
kind: Durable.Await
metadata:
  name: approval
```

`appDb` (a `Sql.Connection` driver), `accountTx`'s inner statements and `sendMail`
are ordinary resources, elided here. `Durable.Await` needs no configuration: it is
addressed by run id plus step name, which the journal already keys on, and it
reaches the journal through the ambient handle rather than naming it — the same
reason `Run.Sequence` gains no `journal:` field. `Durable.Resumer` is the only other
resource that names the journal, and it belongs in the Application's `targets`.

The journal shares `appDb` with the transaction, which is realistic but buys nothing
yet: writing the journal entry inside the business transaction is the deferred
follow-up, so the at-least-once window still applies.

`accountTx` is a `Sql.Transaction`, so its body is one journal entry: a crash inside
it re-runs the whole transaction, which is safe because the database rolled it back.
The step's `retry` sits *outside* the zone and retries the transaction whole — a
retry with a suspending delay *inside* the body would be a diagnostic.

`approval` is a `Durable.Await`: the run parks, releases its kernel hold, and the
application may exit. A `Durable.Deliver` call — from an HTTP route, days later, in
a different process — wakes it. `Durable.Resumer` replays from the journal:
`createAccount` returns its recorded result without re-running the transaction, and
execution continues at `sendWelcome`. `requireCheckpoints: true` means a caller may
not collapse this sequence into one entry, because re-running it would create a
second account and send a second email. Moving `approval` inside `accountTx` would
fail `telo check`, printing the transaction's own `x-telo-no-suspend` reason.

An HTTP route triggers this by invoking `onboard`, which records the run, dispatches
the body detached under a fresh cancellation scope, and returns the run id — so the
response goes out while onboarding continues. A route invoking `onboardSteps`
instead fails `telo check`: it carries `approval`'s suspension requirement, and the
diagnostic names that path.
