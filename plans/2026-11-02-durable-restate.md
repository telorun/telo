---
status: approved
priority: low
depends-on: []
packages: [modules/restate]
---

# Durable execution on Restate — `modules/restate`

This adds a second durable backend: a Restate server instead of a journal the app owns. The same
`steps:` body that runs under `DurableLocal.Workflow` runs here verbatim. That claim is what this
plan proves.

Restate is the first backend whose runs the app does not drive. That makes it the first test of
five things:

- re-entry from an inbound call;
- the root-context construction;
- parking as an engine timer rather than a stored wake time;
- delivery through the engine's ingress;
- a run identity that is the engine's key.

If the seam is wrong about who owns the lifecycle, it fails here, which is why this lands before
Temporal. The seam does not change. If it has to, that is a finding about the seam, reported
before any other work continues.

## Before

Durable work runs only on `durable-local`. An app that already operates Restate has to run a
second durability mechanism beside it, and gets none of Restate's own features: deployment
pinning, its timers and awakeables, its ingress.

## After

A library `Restate` in `modules/restate` (MIT, with its own `LICENSE`) that imports `durable` and
exports seven kinds. Every name and field below is fixed by this plan.

- **`Restate.Workflow`**: `Telo.Invocable`, `extends: Durable.Run`.
  - Fields:
    - `endpoint`: a reference to a `Restate.Endpoint`;
    - `name`: the Restate workflow name;
    - `key`: CEL over `inputs`, the run identity; omitted, one is minted;
    - `idempotency`: `attach` | `reject`, default `attach`;
    - `steps`;
    - `inputs`.
  - `steps` carries `x-telo-provides-zone` with `replayed` and is a `call` slot. The body is
    awaited inside Restate's invocation, so it is not `detached`.
  - Invoking it submits the workflow through Restate's ingress, keyed by `key`, and returns
    `{ runId, status, started?, attached? }` without executing anything. Restate admits the run
    durably and then calls the endpoint.
- **`Restate.Endpoint`**: a `Telo.Mount`, mounted on an `Http.Server` like any other HTTP mount.
  - Field: `ingress`, the Restate ingress URL.
  - It serves every `Restate.Workflow` that names it: the exclusive `run` handler, plus a shared
    `status` handler reporting where the run stands.
  - It speaks Restate's request-response protocol over HTTP/1.1, so the app opens no second
    listener.
  - It dispatches the body on a root context (the inbound obligation, spec §7 item 3) and layers
    the durable zone and the run handle onto that root.
- **`Restate.Register`**: a `Telo.Runnable`, listed in `targets:` after the server.
  - Fields: `endpoint`, `admin` (the admin API URL), `advertise` (the URL Restate calls the
    endpoint on).
  - It registers the endpoint's deployment with the admin API. Registering an unchanged
    deployment again is a no-op, and a refusal fails the target with Restate's own message.
  - It is a separate kind because registration is an observable effect that must follow
    `listen()`, and a mount has no `run()`.
- **`Restate.Awakeable`**: a `Telo.Invocable`, the wake side of `Durable.Await`.
  - Fields: `ingress`, `await` (a schema reference to the `Durable.Await`), `token`, `payload`
    (typed from the await's `outputType` through `x-telo-schema-from`, as on
    `DurableLocal.Deliver`).
  - It resolves the awakeable through the ingress, never through the run's exclusive handler.
  - A payload the named await refuses is `ERR_DURABLE_PAYLOAD_INVALID`.
- **`Restate.Result`**: a `Telo.Invocable` that reads a run's output by `key`, optionally waiting
  (`wait:`) through Restate's attach.
- **`Restate.Schedule`**: a `Telo.Invocable` that submits a run delayed by `after` or until `at`,
  with stored `inputs`, through the ingress's delayed send.
- **`Restate.Cancel`**: a `Telo.Invocable` that stops a run.
  - Field: `mode`, either `cancel` (Restate's cancellation, which runs the body's unwinding) or
    `kill` (Restate's kill). These are Restate's two verbs, kept as two.

**The run handle on Restate:**

- `step` executes in-process through the kernel's chokepoint inside a Restate `run` block named
  by the step path, so Restate's journal records the result.
- `decide` records its value the same way.
- `writesInside` answers no.
- `park` becomes a Restate durable timer (`until.at`) or an awakeable whose id is the token. When
  it completes, the workflow re-runs the body within the same invocation.
- The handle answers any path it has already answered in this invocation from memory, so a re-run
  adds no journal entry. A fresh Restate attempt replays the same entries in the same order.
- Every suspension rule holds unchanged: the latch, `ERR_DURABLE_SUSPENSION_SWALLOWED`, and branch
  parking.

**There is no journal, resumer, manifest digest or `Resume`.** Restate pins an invocation to the
deployment it started on, so in-flight runs keep executing the code they started with. The module
docs state the operational cost: an old deployment must stay reachable until its runs drain.

**The spec gains conformance item 10:** a delivery never re-enters the body's exclusive handler.
On Restate, an exclusive handler queues behind the running body, so routing a delivery through it
deadlocks the run against the signal that would wake it.

**Per-key virtual-object state is not part of this plan.** No operations for it were ever
specified.

## Verify

Integration tests live under `modules/restate/tests/integration/`. Each starts an exactly-pinned
`restatedev/restate` image through `Container.Instance` over `Docker.Engine`, and stands the app
up with `App.Instance`.

- A three-step body completes, and `Restate.Result` returns its result.
- Killing the app child after step 1 and starting it again finishes the run with step 1 executed
  once (a counter it increments).
- A `Durable.Await` parks the run. `Restate.Awakeable` with a valid payload wakes it, and
  `steps.<await>.result` is that payload. An invalid payload is `ERR_DURABLE_PAYLOAD_INVALID`.
- A `Durable.Sleep` of 2s parks on a Restate timer, and the run completes after it.
- Two starts with the same `key` yield one run, with `attached: true` on the second.
  `idempotency: reject` refuses the second instead.
- `Restate.Cancel` with `mode: cancel` leaves the run cancelled. `Restate.Schedule` with
  `after: 2s` starts the run after the delay.
- A body whose step swallows a park fails with `ERR_DURABLE_SUSPENSION_SWALLOWED`. A two-branch
  iteration with `concurrency: 2`, where one branch parks, completes the other branch before
  parking.
- `telo check` on a `Restate.Workflow` with a `Durable.Sleep` inside a `Sql.Transaction` reports
  the transaction's `noSuspend` reason. This proves the static checks apply with no analyzer
  change.

## Documentation and release

- `modules/restate/README.md` and `docs/` cover the kinds, deployment pinning and draining, and
  registration.
- The benefits ledger gains a standard-library entry: durable work on Restate from the same body.
- The primer and the module overview list Restate as a durable backend.
- Release: an `Added` fragment for `restate`.
