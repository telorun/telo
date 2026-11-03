---
status: approved
priority: high
depends-on: []
packages: [analyzer, modules/durable-local]
---

# Durable execution — what `durable-local` and the analyzer still owe

The seam, the spec (`kernel/specs/durable-execution.md`), `durable`, `durable-local` and both
journals have shipped. Four things are still missing: code-version protection, bounds on a long
run, retention of finished runs, and the missing-contract warning. The Restate and Temporal
backends are separate plans. Temporal's history bound reuses the baseline this plan defines.

## 1. Code-version protection — the manifest digest

**Before.** The run record format declares `manifestDigest` and `digestScope`, but nothing
writes or reads them. A run interrupted by a deploy resumes against the new code silently, even
when the deploy changed a step the run will replay. `ERR_DURABLE_MANIFEST_CHANGED` is listed in
the spec but never raised.

**After.**

- When `DurableLocal.Workflow` admits a run, it records `manifestDigest` as a digest over the
  declarations its body reaches, with `digestScope: reachable`. The reachable set is the call
  graph the containment walk already uses, from the analysis the kernel runs at load. The kernel
  hands the set and its digest to the workflow's controller, which derives nothing itself.
  Hashing the whole manifest would move on every deploy and strand every in-flight run, and a
  deploy is the most common cause of the process death durability exists to survive.
- **Every resume compares digests** (the resumer, re-entry after a delivery, an attaching start).
  A digest that moved parks the run instead of replaying it: `status: parked` with the cause
  `ERR_DURABLE_MANIFEST_CHANGED`, which `DurableLocal.Status` reports. `DurableLocal.Resume`
  remains the operator's override and journals that it was used.
- **The digest is checked against the journal, not trusted.** The containment walk may
  under-approximate (an edge it cannot see degrades to a runtime error). The digest would
  degrade the other way: an unseen edge is code whose change moves nothing. So when the run
  first journals a step whose target is outside the reachable set, the run record widens right
  then: `digestScope: manifest` with the whole-manifest digest of the code writing that entry.
  From then on every resume compares the whole-manifest digest. Every replayed entry recorded
  its target, so this is complete per run, and an app whose dispatches the analyzer fully sees
  never widens.

**Verify.**

- A test runs a run to a park, edits a step on the body's path, and resumes. The run stays
  parked with `ERR_DURABLE_MANIFEST_CHANGED`, and `DurableLocal.Resume` continues it with an
  override entry in the journal.
- Editing a resource the body does not reach and resuming completes normally.
- A body reaching a target through a dynamic dispatch writes `digestScope: manifest` on its
  first such entry. After that, an unrelated edit parks it.

## 2. Bounds on a long run — compaction

**Before.** A long-running run (a polling `while`, a large iteration) grows its journal without
limit, and every resume replays all of it from the first entry.

**After.**

- `DurableLocal.Workflow` gains `compactAfter`, a positive integer defaulting to `1000`: the
  number of entries a run may hold before it compacts.
- When a step completes and the run's entry count passes `compactAfter`, the run writes one
  **baseline**. A baseline holds two things: the step path the run has reached, and every value
  replay would hand back up to that point (the step results and decisions in scope there,
  including the position of each enclosing loop and iteration). In the same journal operation,
  every entry the baseline replaces is removed.
- A replay of a compacted run starts at the baseline instead of the top.
- Compaction is well-defined because decisions are journaled: the baseline is the run's
  replay-closed state and nothing more, so no ambient value has to be re-derived.
- The baseline's format joins spec §5.2 as normative, written here because this plan is the
  first to read one back after a restart. Both journals implement the replace-with-baseline
  operation as one atomic write: a single transaction on Postgres, a rename on the file journal.
- A baseline is taken only at a step boundary, never inside a collapsed region.

**Verify.**

- With `compactAfter: 10`, a `while` body of 50 iterations crashed at iteration 37 and resumed
  continues at 37. The journal holds one baseline plus fewer than 10 entries.
- Both journals pass the same test.
- A crash during compaction leaves either the old entries or the baseline, never both and never
  neither.

## 3. Retention of finished runs

**Before.** Completed, failed and cancelled runs stay in the journal forever.

**After.**

- `DurableLocal.Workflow` gains `retainFinished`, a duration defaulting to `30d`.
- The resumer's sweep deletes a run's record and every entry once it has been finished for
  longer than that.
- `DurableLocal.Status` and `DurableLocal.Result` already answer `unknown` for a purged run.

**Verify.** With `retainFinished: 1s`, a completed run reads `completed` and then, after a sweep
past the window, `unknown`, and the journal holds nothing for it. A parked or running run is
never purged, whatever its age.

## 4. The missing-contract warning

**Before.** A journaled step whose target declares no `outputType` passes `telo check`
silently. Its value is still guarded at runtime (`ERR_DURABLE_UNJOURNALABLE_VALUE` at the
producing step path).

**After.**

- `DURABLE_CONTRACT_REQUIRED` is a **warning**. It is reported at a step inside a `replayed`
  region whose target's contract declares no `outputType`, looking along `extends` and taking
  the nearest.
- A step inside an `idempotent` region is exempt: that region collapses, so the step has no
  entry of its own.
- It keys off the zone attribute and never off a kind.
- It is a warning, not an error, for two reasons. A declared open object would satisfy it while
  proving nothing. And `Sql.Transaction` declares no `outputType`, so an error would refuse the
  recommended shape. The runtime refusal is the gate.

**Verify.** An analyzer test shows the warning at a step invoking a target with no
`outputType` inside `DurableLocal.Workflow.steps`, and no warning inside a `Durable.Idempotent`
body or outside any replayed region.

## Documentation and release

- `modules/durable-local/docs/` gains the digest, compaction and retention behaviour.
- `docs/reference/diagnostics.md` gains `DURABLE_CONTRACT_REQUIRED`.
- The spec gains the baseline format and the widening rule.
- The benefits ledger extends its durable-execution entry with "a deploy never replays a run
  against code it did not start with" and bounded long runs.
- The primer is updated where it describes `DurableLocal.Workflow`.
- Release: one `Added` fragment for `durable-local`, one for each journal, and a changeset for
  the analyzer and kernel.
