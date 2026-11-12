---
status: in-progress
priority: high
depends-on: []
packages: [analyzer, kernel, sdk, modules/durable-local, modules/durable-journal-file, modules/durable-journal-postgres]
refinement: not-ready
tracking: feat/durable-remainder
---

# Durable execution — code-version protection

The seam, the spec (`kernel/specs/durable-execution.md`), `durable`, `durable-local`, both
journals, compaction, retention of finished runs and the missing-contract warning have shipped.
One thing is still missing: a run interrupted by a deploy must not resume against code it did not
start with. The Restate and Temporal backends are separate plans.

## Problem

The run record format declares `manifestDigest`, but nothing writes or reads it.
`ERR_DURABLE_MANIFEST_CHANGED` is listed in the spec and never raised. A run interrupted by a
deploy resumes against the new code silently, even when the deploy changed a step it will replay,
a kind that step uses, or the version of a library the kind comes from.

## Design

**The manifest digest covers the code a run replays.** `DurableLocal.Workflow` records
`manifestDigest` (`sha256-<hex>`) on the run record when it admits the run, and a
`DurableLocal.Schedule` run records it when it first starts. It is a digest of the body and
everything the body reaches, followed transitively through:

- every `!ref` written anywhere inside a reached declaration, whether or not a slot declares it;
- every module call, every CEL read of another resource's published state, every co-referrer
  dispatch;
- each reached declaration's kind definition and its whole `extends` chain;
- every import declaration through which a reached declaration or kind arrives — its source text
  carries the pin, so a library's published version is covered with no rule of its own.

Inline targets and `with:` scope members are part of their holder. Out of the digest: the
workflow's own `journal`, `compactAfter`, `onConflict` and `retainFinished`; the body's `inputs:`
mapping (journaled as a decision, never re-evaluated on replay); values resolved from the
environment (variables, secrets, need fields); built-in `Telo.*` kinds beyond their name. A
controller's code is covered through its module's pin, so a source checkout with no pin is
covered through its YAML only. Hashing the whole manifest would move on every deploy and strand
every run; the reach is what makes the guard usable. The digest is of the loaded generation, so
under `telo run --watch` an edit to reached code blocks that run's in-flight runs until
`DurableLocal.Resume` adopts them; the spec says the digest covers code, never live state, beside
its existing rule that a digest-and-detect scheme must not replace the journal's own mismatch
check.

**One definition, in the spec.** The digest is the SHA-256 of the RFC 8785 canonical text of the
sorted list of reached declarations. Each declaration is its module-instance path, canonical kind
and `metadata.name`, with its body in the written-value encoding, as written, before migrations.
An `!include-*` tag is its content's digest; a `!module-path` tag is its path text. Left out:
positions, comments, key order, every `metadata` key but `name`, loader stamps and module
locations. The spec holds the definition and cites `analyzer/manifest-digest-conformance/`, which
every implementation holds itself to: a `README.md` and `vectors/<case>/` directories, each a
`telo.yaml` with any files it includes or imports and an expected `digest.json`, such as

```json
{ "field": "fulfil/steps", "manifestDigest": "sha256-3b1f6c0d5a7e9824c1d0b6f3a2e87d45f90c1b2a3d4e5f60718293a4b5c6d7e8" }
```

The Node analyzer computes it at load for every field that provides a `replayed` zone; the Rust
analyzer owes it when the Rust kernel can host the workflow. The kernel hands it to a controller
through the controller-protocol message `Manifest.Digest`, surfaced as `ctx.manifestDigest(field)`
(the replayed field, named as `ctx.withZone` names it); both carriers carry it, and the data,
spec and guide gain it:

```json
{ "request": { "instance": "fulfil", "field": "steps" },
  "response": { "manifestDigest": "sha256-3b1f6c0d5a7e9824c1d0b6f3a2e87d45f90c1b2a3d4e5f60718293a4b5c6d7e8" } }
```

**A block is derived, never stored.** The record keeps only `manifestDigest`. A claim has two
arms. Renewal by the holder of a live lease never looks at the digest, so no operator action can
take a healthy run from a replica that is mid-step. Acquisition — no live lease — carries the
replica's digest and succeeds only when the record's equals it or is absent, stamping an absent
one in the same write; a holder whose lease lapsed takes the acquisition arm. A run is **blocked
here** when its digest differs from this replica's and no live lease exists; the record read
reports a live lease as `claimedUntil`. The resumer's due listing filters on the same condition.
A run recorded under another digest keeps its stored status, so a rolling deploy never strands
new-code runs and a rollback resumes the old ones with no operator step. A run with no recorded
digest (a scheduled run before its start, an old record) takes the digest of the first execution
that acquires it. Both journals store and claim on the digest; the Postgres journal declares a
`manifest_digest` column. On the file journal a live lease is visible within one process only,
which is its declared contract.

**What callers see of a blocked run.** An attaching start (`onConflict: attach`) answers as for
any running run and executes nothing; `DurableLocal.Result` waits as for any running run;
`DurableLocal.Cancel` works as today, since it only writes the journal; a delivery is recorded as
today and answers `delivered: true`, and the run continues with that payload once a matching
replica or an adoption lets a replica take it. Only `DurableLocal.Status` reports the block.

**`DurableLocal.Status`** names the `workflow` (as `Resume` does; `Result`, `Cancel` and
`Deliver` keep the `journal`, since only these two need the digest) instead of the `journal`, and
reports `blocked: { code, message }` when the run is blocked here; the field is absent otherwise.
At init the `Workflow` logs its digest as `durable.manifest_digest`, so a deploy's effect on
in-flight runs is predictable from the logs.

**`DurableLocal.Resume`** adopts the code deployed here, through one journal operation,
`adoptRun`, that atomically checks the run is blocked here and not finished, rewrites the digest
and appends the entry at `override/resume/<at>` — the path today's `Resume` writes, `<at>` the
epoch milliseconds — with the value `{ reason, at, manifestDigest, previousManifestDigest }`
(`at` an ISO string). It no longer unparks the run: a blocked run keeps its stored status and a
parked one wakes on its deadline or delivery. A later deploy blocks the run again only if it
changes the reached code again. Its output is `{ run, resumed, status }`, `status` the run's
stored status, and `resumed: false` for a run that is not blocked here, a live lease included.
Both journals implement `adoptRun` as one write (a single conditional statement with a CTE on
Postgres; one staged rewrite and rename on the file journal).

## Before / After

**Before** — a deploy edits the `shipped` step while run `order:42` waits for its approval; once
it is approved the resumer replays it against the edited step, and `Status` reports only:

```
{ run: "order:42", status: "parked", parked: { path: "steps/waitForApproval", resource: "approval" } }
```

and `Status` is declared with `journal: !ref journal`.

**After** — one manifest, run by the command line, saved as
`modules/durable-local/docs/order-flow/telo.yaml` (its imports are relative to it). Boot 1 starts
the run, which parks on its approval and leaves the process with nothing to do:

```
$ telo run ./manifest.yaml --order 42
```

The deploy changes only the `shipped` step's value, from `{ stage: ship }` to
`{ stage: shipped }`, and leaves `unused` alone. The approval arrives; the run is recorded as
delivered but not taken:

```
$ telo run ./manifest.yaml --approve 42
42 delivered: true
```

The operator looks:

```
$ telo run ./manifest.yaml --run order:42
order:42 parked — Run order:42 started on different code than this replica runs; it continues on a replica running that code, or after DurableLocal.Resume adopts the code deployed here.
```

and adopts the run, then starts the resumer, which continues it:

```
$ telo run ./manifest.yaml --run order:42 --reason "shipped only changed a label"
order:42 resumed: true
$ telo run ./manifest.yaml
$ telo run ./manifest.yaml --run order:42
order:42 completed
```

The run record had `manifestDigest: sha256-3b1f6c0d5a7e9824c1d0b6f3a2e87d45f90c1b2a3d4e5f60718293a4b5c6d7e8`;
this replica's is `sha256-7c0e5d91b3a24f680d1c9e7a52b48f36a1d0c7e94b6f283591ae0c7d5f3b2a64`. The
journal gains `override/resume/1794476467512` with the value

```
{ reason: "shipped only changed a label", at: "2026-11-12T09:41:07.512Z", manifestDigest: "sha256-7c0e5d91b3a24f680d1c9e7a52b48f36a1d0c7e94b6f283591ae0c7d5f3b2a64", previousManifestDigest: "sha256-3b1f6c0d5a7e9824c1d0b6f3a2e87d45f90c1b2a3d4e5f60718293a4b5c6d7e8" }
```

and the record's digest becomes the second one. Adopting again answers
`order:42 resumed: false`; so does adopting while another replica still holds a live lease on the
run. Rolling back to the first manifest instead of adopting needs no operator step: its resumer
claims the run again, its digest matching. Editing only `unused` between boots changes no digest
and blocks nothing.

The manifest:

```yaml
kind: Telo.Application
metadata:
  name: OrderFlow
  version: 1.0.0
imports:
  Console: ../../../console
  Durable: ../../../durable
  Local: ../..
  Journal: ../../../durable-journal-file
variables:
  journalDir:
    env: ORDER_FLOW_DIR
    type: string
    x-telo-type: Telo.HostPath
    default: .telo/order-flow
  order: { arg: { flag: order }, type: string, default: "" }
  approve: { arg: { flag: approve }, type: string, default: "" }
  run: { arg: { flag: run }, type: string, default: "" }
  reason: { arg: { flag: reason }, type: string, default: "" }
targets:
  - { ref: !ref resumer, when: !cel "variables.run == '' && variables.order == '' && variables.approve == ''" }
  - { ref: !ref start, when: !cel "variables.order != ''" }
  - { ref: !ref deliver, when: !cel "variables.approve != ''" }
  - { ref: !ref inspect, when: !cel "variables.run != '' && variables.reason == ''" }
  - { ref: !ref adopt, when: !cel "variables.run != '' && variables.reason != ''" }
---
kind: Journal.Journal
metadata: { name: journal }
directory: !cel "variables.journalDir"
---
kind: Durable.Await
metadata: { name: approval }
token: !cel "'approve:' + inputs.order"
timeout: 30d
outputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [approvedBy]
    additionalProperties: false
    properties: { approvedBy: { type: string } }
---
kind: Local.Workflow
metadata: { name: fulfil }
journal: !ref journal
runId: !cel "'order:' + inputs.order"
inputs:
  order: !cel "inputs.order"
steps:
  - { name: charged, invoke: { kind: Telo.Value, value: { stage: charge } } }
  - { name: waitForApproval, invoke: !ref approval, inputs: { order: !cel "inputs.order" } }
  - { name: shipped, invoke: { kind: Telo.Value, value: { stage: ship } } }
---
# Reached by nothing: editing it moves no digest.
kind: Telo.Value
metadata: { name: unused }
value: { stage: audit }
---
kind: Local.Resumer
metadata: { name: resumer }
workflow: !ref fulfil
---
kind: Telo.Sequence
metadata: { name: start }
steps:
  - name: started
    invoke: !ref fulfil
    inputs: { order: !cel "variables.order" }
---
kind: Telo.Sequence
metadata: { name: deliver }
steps:
  - name: approved
    invoke:
      kind: Local.Deliver
      journal: !ref journal
      await: !ref approval
      token: !cel "'approve:' + inputs.order"
      payload: { approvedBy: !cel "inputs.by" }
    inputs: { order: !cel "variables.approve", by: ada }
  - name: print
    invoke: !ref Console.writeLine
    inputs:
      output: !interpolate "${{ variables.approve }} delivered: ${{ steps.approved.result.delivered }}"
---
kind: Telo.Sequence
metadata: { name: inspect }
steps:
  - name: status
    invoke: { kind: Local.Status, workflow: !ref fulfil }
    inputs: { run: !cel "variables.run" }
  - name: print
    invoke: !ref Console.writeLine
    inputs:
      output: !interpolate "${{ variables.run }} ${{ steps.status.result.status }}${{ has(steps.status.result.blocked) ? ' — ' + steps.status.result.blocked.message : '' }}"
---
kind: Telo.Sequence
metadata: { name: adopt }
steps:
  - name: resume
    invoke: { kind: Local.Resume, workflow: !ref fulfil, reason: !cel "variables.reason" }
    inputs: { run: !cel "variables.run" }
  - name: print
    invoke: !ref Console.writeLine
    inputs:
      output: !interpolate "${{ variables.run }} resumed: ${{ steps.resume.result.resumed }}"
```

## Verify

- A test runs a run to its park, boots a second fixture manifest with an edited step on the body's
  path over the same journal directory, and shows `Status` reporting `blocked` with
  `ERR_DURABLE_MANIFEST_CHANGED`; the resumer there never claims the run, an attaching start and
  `Result` answer as for a running run, and `Cancel` still cancels; a delivery answers
  `delivered: true`; `Resume` records an `override/resume/<at>` entry and the run then completes;
  a third boot of the edited manifest does not block it.
- Editing a resource the body does not reach, a workflow setting outside the body, or an
  environment value leaves the digest unchanged and the run completes.
- Editing any one of a step, a reached kind's template body, a reached library's pin, or a
  resource reached only through a `!ref` at a position no slot declares changes it.
- While a replica holds a live lease under the first digest, a replica with the second: `Resume`
  answers `resumed: false`, the holder's renewals keep succeeding, `Status` reports no `blocked`,
  and no second executor appears; once the lease lapses `Status` reports `blocked`. A lapsed
  holder cannot re-acquire a run adopted away from it, on both journals.
- Two concurrent `Resume` calls against the same blocked run leave exactly one entry and one
  `resumed: true`; a fault between the check and the write leaves either both the entry and the
  new digest or neither, on both journals. Adopting, rolling back, adopting the same digest again
  journals two entries.
- A Postgres test under `modules/durable-journal-postgres/tests/integration/` runs two resumers
  with different digests on one journal: neither acquires the other's runs, and returning to the
  first digest resumes what the second left.
- The Node analyzer reproduces every vector; the same manifest loaded from two directories gives
  one digest; reordering keys or adding comments does not move it; editing an included file's
  content does, renaming its path with the same content does not.
- A `Schedule` run and an old record with no digest take the first acquirer's digest.

## Documentation and release

- `modules/durable-local/docs/` gains the digest, the two claim arms, the derived block, what
  callers see of a blocked run, `Status.blocked`, adopt semantics of `Resume`, the `workflow`
  rule for `Status` and `Resume`, the order-flow example, and the advice to keep an old replica
  running to drain its own runs.
- The spec gains the digest definition and its vectors, the two claim arms, `adoptRun`, the
  derived block, and drops `digestScope`; the containment walk's comment no longer says the
  digest is verified against the journal.
- The controller-protocol data, spec and guide gain `Manifest.Digest`
  (`pnpm run check:controller-protocol`).
- The benefits ledger extends its durable-execution entry: a deploy that changes the code a run's
  durable body reaches — its steps, the kinds and published module versions they use — never
  replays that run silently; it waits for a replica running its code or an operator's resume.
- The primer describes `DurableLocal.Status` naming a `workflow`, `blocked` and `Resume`'s adopt
  semantics.
- Release: one changeset for the telo line (analyzer, kernel, sdk); one `Added` fragment each
  for `durable-local`, `durable-journal-file` and `durable-journal-postgres`, each body naming
  only its own change; the `>=unreleased` entry in `durable-local`'s `restrictions:` gains the
  reason that its controller needs the runtime's `ctx.manifestDigest`.
