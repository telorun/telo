---
status: approved
priority: low
depends-on: [2026-11-02-durable-restate.md, 2026-11-02-durable-execution-remainder.md]
packages: [modules/temporal]
---

# Durable execution on Temporal — `modules/temporal`

This adds a third durable backend: Temporal. It is the first backend where the step engine runs
somewhere the resource graph does not:

- the body executes inside a Temporal workflow isolate, which performs no I/O;
- every effect leaves the isolate as an activity, run back in the app's kernel;
- a second runtime derives each step target from the encoding in spec §5.3.

It lands after the Restate plan, and after the remainder plan's baseline, which it uses to bound
history.

**The isolate is the gate.** Nobody has yet run a Telo step engine inside a Temporal workflow
isolate, so the first card is that spike. If the step engine and CEL evaluator cannot load and
run in the isolate, this plan ends there:

- the finding is written into spec §10;
- nothing else is built;
- no shipped slice depends on Temporal.

## Before

An app on Temporal cannot run a Telo body durably. It would have to restate its logic as
TypeScript workflow code, which is exactly the engine-specific grammar the step engine replaced.

## After

A library `Temporal` in `modules/temporal` (MIT, with its own `LICENSE`) that imports `durable`.
Its kinds use Temporal's own vocabulary, and every name and field below is fixed by this plan.

- **`Temporal.Client`**: a `Telo.Provider`.
  - Fields: `address`, `namespace`, `apiKey` (sensitive; omitted for an unauthenticated server),
    `tls`.
  - It opens one connection, which its inverse closes.
- **`Temporal.Workflow`**: `Telo.Invocable`, `extends: Durable.Run`.
  - Fields:
    - `client`;
    - `taskQueue`;
    - `workflowId`: CEL over `inputs`; omitted, one is minted;
    - `idReusePolicy`: `allowDuplicate` | `allowDuplicateFailedOnly` | `rejectDuplicate` |
      `terminateIfRunning`;
    - `idConflictPolicy`: `fail` | `useExisting` | `terminateExisting`;
    - `activityTimeout`: default `10m`;
    - `continueAsNewAfter`: optional, a history event count; omitted, Temporal's own suggestion
      decides;
    - `steps`;
    - `inputs`.
  - `steps` carries `x-telo-provides-zone` with `replayed` and is a `call` slot.
  - Invoking it starts an execution and returns `{ runId, status, started?, attached? }`, with
    `runId` being the workflow id, without executing anything.
- **`Temporal.Worker`**: a `Telo.Service`, listed in `targets:`.
  - Fields: `client`, `taskQueue`, `workflows` (a list of references to `Temporal.Workflow`,
    `use: trigger.consumer`).
  - It long-polls the task queue and holds the kernel while polling.
  - It hosts the isolate that runs each workflow body, and executes the activities those bodies
    issue.
- **`Temporal.Signal`**: the wake side of `Durable.Await`.
  - Fields: `client`, `workflowId`, `await` (a schema reference), `token`, `payload` (typed from
    the await's `outputType`).
  - Delivery is a signal and never a body re-entry, per spec §7 item 10.
- **`Temporal.Update`**: like `Temporal.Signal`, but it returns once the run has accepted the
  value. A payload the await refuses is rejected to the caller as `ERR_DURABLE_PAYLOAD_INVALID`.
- **`Temporal.Query`**: reads where a run stands (running, parked and at what, finished) through a
  built-in query the workflow answers.
- **`Temporal.Result`**: reads a run's result, optionally waiting (`wait:`).
- **`Temporal.Cancel`**: stops a run. `mode` is `cancel` (requests cancellation, which the body
  observes at its next park or step) or `terminate`.
- **`Temporal.Schedule`**: a `Telo.Runnable` listed in `targets:`.
  - Fields: `client`, `workflow`, `cron`, `overlapPolicy` (Temporal's six values), `catchupWindow`,
    `inputs`.
  - It reconciles one Temporal Schedule to the declaration, creating or updating it. It never
    deletes the schedule on shutdown, since a schedule the app does not own is the point: a firing
    missed while the app is down still happens.
- **`Temporal.SearchAttribute`**: fields `workflow`, `field`, `value` (CEL over the run's
  `inputs`). The attribute is set on each run of that workflow when it starts.

**Where each piece of the run executes:**

- **The step engine and CEL evaluator run inside the isolate**, bundled into the workflow code the
  worker loads. Control flow there is a pure function of recorded values, because `decide` has
  journaled every impure input. That is what makes this sound.
- **`step`** becomes an activity executed by the worker in the app's kernel. It is addressed by
  the encoded target identity and dispatched through the kernel's chokepoint, so contracts,
  tracing and zones hold there (spec §7 item 2).
  - Its start-to-close timeout is the step's `timeout:`, else `activityTimeout`.
  - Temporal's own activity retry is off (one attempt), because the Telo retry policy runs in the
    step engine. A backoff that would suspend becomes a Temporal timer.
- **`decide`** becomes a local activity. The worker evaluates the expression against the kernel's
  scope plus the run state the isolate passes in, and Temporal history replays the value.
- **A step whose target opens a zone runs whole inside one activity.** Its inner steps execute
  locally there, and the activity's result is their one record. That is the locality rule
  (spec §7 item 5) and the collapse rule, applied unchanged.
- **`park`** becomes a workflow timer, or a wait on a signal carrying the token.
- **`writesInside`** answers no.
- **A body declaring a `with:` scope is refused when the workflow starts**, with
  `ERR_DURABLE_TARGET_UNENCODABLE` naming the scope. The scoped identity form is encodable but not
  yet derived.
- **History is bounded by continue-as-new.** When Temporal suggests it, or `continueAsNewAfter` is
  reached, at a step boundary, the execution continues as new and carries the run's baseline
  (spec §5.2, from the remainder plan) as its input.

**There is no journal, resumer or manifest digest.** Temporal's worker versioning pins in-flight
executions to their code.

## Verify

The isolate spike, as a unit test in the module: a body with a branch, a loop and a CEL decision
over `steps.<name>.result` runs in a Temporal test environment. No Node built-in is reached from
the isolate bundle.

Integration tests live under `modules/temporal/tests/integration/`. Each starts an
exactly-pinned `temporalio/temporal` dev-server image through `Container.Instance`, and stands
the app up with `App.Instance`.

- A three-step body completes, and `Temporal.Result` returns its result.
- Killing the worker app after step 1 and starting it again finishes the run with step 1 executed
  once.
- `Durable.Await` with `Temporal.Signal` wakes the run with the typed payload.
  `Temporal.Update` with a refused payload returns `ERR_DURABLE_PAYLOAD_INVALID`.
- `idConflictPolicy: useExisting` attaches the second start, and `fail` refuses it.
- `Temporal.Cancel` cancels the run. `Temporal.Query` reports a parked run's park point.
- `Temporal.Schedule` creates a schedule visible to the server, and a second boot leaves exactly
  one.
- A search attribute is queryable through the server's visibility list.
- A loop with `continueAsNewAfter: 50` running past it continues as new and completes with every
  step executed once.
- A step target that does not survive encoding fails with `ERR_DURABLE_TARGET_UNENCODABLE` at its
  step path.
- `telo check` reports the same `noSuspend` and `DURABLE_NONDETERMINISM` diagnostics on a
  `Temporal.Workflow` body as on a `DurableLocal.Workflow` body, with no analyzer change.

## Documentation and release

- `modules/temporal/README.md` and `docs/` cover the isolate and what runs where, worker
  versioning, and the `with:` limitation.
- The benefits ledger extends the durable-execution entry with Temporal.
- The primer and the module overview list Temporal as a durable backend.
- Release: an `Added` fragment for `temporal`.
