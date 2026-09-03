---
description: "Make a body of steps survive process death: record progress as it runs so a crash and a restart continue where the work stopped, wait for days without holding a process, and know exactly which regions may re-run."
---

# Durable execution

Some work must not be done twice and must not be lost: charging a card, sending
an order to a warehouse, provisioning an account across three systems. A
`Run.Sequence` gives you the steps; what it does not give you is an answer to
"what happens if the process dies between step two and step three?". Durable
execution is that answer, and in Telo it is the **same step grammar** with a
record kept beside it.

This guide builds an order-fulfilment run, kills it, and watches it continue.
The finished manifest is [`examples/durable-orders`](/examples).

## 1. What is recorded, and when

A durable body records each step's outcome **when the step completes** — never
when it is dispatched. That single rule is what makes recovery correct:

- a step that finished is never re-entered; its result comes back from the
  record;
- a step that was interrupted has no record, so it runs again.

Recording on dispatch would mark the charge done the instant it was *attempted*,
and a crash one line later would skip it forever. Recording on completion means
an interrupted charge is retried, which is what you wanted.

More than results are recorded. A step's resolved inputs, every branch predicate,
every loop condition and every pure `value:` step are written too. They are read
from a scope that includes live readings — a resource's observed state is
republished on every dispatch by design — so recomputing one in a fresh process
can answer differently, and the failure that causes has no error attached to it.
A resume feeds the recorded decisions back rather than re-deriving them, which
makes a replay a function of the record alone.

## 2. A body, a journal, a run id

Three resources: something to record into, the body, and a way to start it.

```yaml
kind: Telo.Application
metadata:
  name: Orders
  version: 1.0.0
imports:
  Durable: oci://ghcr.io/telorun/durable@<version>
  Local: oci://ghcr.io/telorun/durable-local@<version>
  Journal: oci://ghcr.io/telorun/durable-journal-file@<version>
  Run: oci://ghcr.io/telorun/run@<version>
variables:
  orderId:
    env: ORDER_ID
    type: string
targets:
  - invoke: !ref fulfil
    inputs:
      order: !cel "variables.orderId"
---
# Where the run is recorded: one append-only file per run, flushed as each
# record is written, so a kill -9 loses nothing that had already finished.
kind: Journal.Journal
metadata: { name: orders }
directory: ./.telo/orders
---
kind: Local.Workflow
metadata: { name: fulfil }
journal: !ref orders
# Derived from the order, so submitting the same order again CONTINUES the
# existing run rather than starting a second one — an idempotent start.
runId: !cel "'order:' + inputs.order"
onConflict: attach
inputs:
  order: !cel "inputs.order"
steps:
  - name: reserve
    invoke: !ref reserveStock
    inputs: { order: !cel "inputs.order" }
  - name: charge
    invoke: !ref chargeCard
    inputs: { order: !cel "inputs.order" }
  - name: ship
    invoke: !ref shipOrder
    inputs:
      order: !cel "inputs.order"
      paymentRef: !cel "steps.charge.result.ref"
```

`reserveStock`, `chargeCard` and `shipOrder` are ordinary invocables — a
`Run.Sequence`, an `Http.Request`, a `Sql.Command` — declared exactly as they
would be anywhere else. Nothing about them knows it is inside a durable run.

Three things to notice:

- **`runId` is the identity of the work.** The run is recorded under it
  *before* anything executes, which is what makes recovery possible: a process
  that dies between recording and executing leaves a run with no progress, and
  that is exactly what a resume looks for. Omit it and one is minted; then every
  start is a fresh run.
- **`onConflict: attach`** says what a second start with the same id does:
  attach to the existing run, which for a completed run means answering with
  what it produced. `reject` fails instead.
- **A start does not wait.** `Local.Workflow` returns as soon as the run is
  recorded — `{ runId, started: true, status: "running" }` — and the body keeps
  going. Section 4 says why, and how to read the outcome.

Run it, and hard-kill it while it is charging:

```bash
ORDER_ID=A-1 telo ./orders.yaml &
sleep 5 && kill -9 %1
cat .telo/orders/*.ndjson        # one line per completed step
ORDER_ID=A-1 telo ./orders.yaml  # continues: reserve is not re-run
```

The record shows `reserve` with its result and `charge` without one. The second
run does not print anything about reserving stock — that step's result came back
from the file — and resumes at the charge.

**Ctrl-C does not interrupt a durable run**, and that is deliberate: the run must
outlive whatever triggered it, so it does not inherit the caller's cancellation.
If it did, a run started by an HTTP request would be cancelled the moment the
response went out. What stops it is the process going away — the case this
feature exists for — and `Local.Cancel` for a decision to call it off.

## 3. Retrying, and knowing when not to

A retry policy lives on the step, the same `retry:` every step body accepts:

```yaml
  - name: charge
    invoke: !ref chargeCard
    inputs: { order: !cel "inputs.order" }
    retry:
      attempts: 3
      initialDelay: 500
      nonRetryable: [ERR_PAYMENT_DECLINED, ERR_CARD_EXPIRED]
```

`nonRetryable` is what stops a terminal failure spending the budget. For a card
charge, three more attempts are three more chances to double-charge, not merely
wasted time. Each attempt is one dispatch; only the attempt that completes is
recorded.

A backoff longer than 30 seconds does not sleep — it **parks** the run (section
4), which is what makes a long backoff free. It is also why such a retry is
refused inside a region that cannot be held open (section 5).

## 4. Waiting for days

A body can wait — for a duration, or for a value delivered from outside — and
**a waiting run holds nothing**. The process may exit, be redeployed and pick
the work up in a different process days later.

```yaml
kind: Durable.Sleep
metadata: { name: cooldown }
for: 24h
---
kind: Durable.Await
metadata: { name: approval }
# The address a delivery must carry. Written here because the email that
# carries the link is sent BEFORE the wait starts; omit it and one is minted.
token: !cel "'approve:' + inputs.order"
# What the delivery carries — per instance, so the steps reading this result
# type-check against a real shape.
outputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [approvedBy]
    properties:
      approvedBy: { type: string }
```

Both name nothing — no run reference, no backend import. They find the run they
are executing inside off the invocation context, so the same steps work under
any engine.

The delivering side is the engine's, because waking a run is where engines
genuinely differ. It takes the **journal**, not the workflow — a webhook receiver
has the store and nothing else — and naming the await checks the payload against
the shape it declared:

```yaml
kind: Local.Deliver
metadata: { name: approve }
journal: !ref orders
await: !ref approval
token: !cel "inputs.token"
payload:
  approvedBy: !cel "inputs.by"
```

A delivery does not continue the run. It writes the value at the wait's own
position and the **resumer** picks the run up on its next pass — which is what
lets a delivery land in a process that will never execute the body:

```yaml
kind: Local.Resumer
metadata: { name: resumer }
workflow: !ref fulfil
interval: 5s
```

Two things follow from "a start does not wait":

- **Something has to resume.** A resumer polls for runs whose process died or
  whose wait is over, claims each one so two pollers never both take it, and
  continues it through the workflow's own execution path. It holds the process
  open for as long as it polls — right for a service, wrong for a one-shot
  script, where submitting the same run id again does the same job.
- **Reading the outcome is a separate ask.** `Local.Result` answers with the
  run's state, optionally waiting a bounded time for one still in progress:

  ```yaml
  kind: Local.Result
  metadata: { name: outcome }
  journal: !ref orders
  wait: 30s
  ```

  An HTTP route that starts a run therefore responds at once with the run id,
  and a second route hands the caller the result when they ask.

## 5. Regions that re-run whole

Everything is recorded by default, so the burden sits on the cheap case:
forgetting to record an effectful step is the failure nobody notices. The other
direction is opt-in. A region you know is safe to re-run needs *one* record
rather than one per step:

```yaml
kind: Durable.Idempotent
metadata: { name: notifyAtMostTwice }
reason: the mail is keyed on the order id, so a re-send replaces the queued copy
steps:
  - name: send
    invoke: !ref notifyCustomer
```

`reason:` is required, and required as prose. Whatever reports on this region
quotes it — an operator asking "why is this at-least-once?" reads your sentence.

A collapsed region **re-runs with its earlier effects intact**, so an impure
expression inside it — `uuidv4()`, `now()` — yields a different value the second
time and falsifies the claim you signed. `telo check` reports that as
`DURABLE_NONDETERMINISM`; the fix is to pin the value once:

```yaml
kind: Durable.Value
metadata: { name: batchId }
value: !cel "uuidv4()"
```

Collapse suppresses per-step records, never the recording itself, so this
replays where everything around it does not.

Some regions promise the opposite of waiting: a transaction holds a connection,
a lease expires on its own clock. A `Durable.Sleep` inside a `Sql.Transaction`
is a `telo check` error (`ZONE_ATTRIBUTE_VIOLATED`) that prints both sentences —
the region's promise and the wait's rebuttal — and the runtime refuses too
(`ERR_DURABLE_SUSPEND_FORBIDDEN`), because the static check sees only the paths
it can trace.

## 6. Running it for real

A directory of files is genuinely durable and is the right journal for one
machine. For several, and for the strongest guarantee, the journal moves into
PostgreSQL:

```yaml
imports:
  Journal: oci://ghcr.io/telorun/durable-journal-postgres@<version>
---
kind: Journal.Journal
metadata: { name: orders }
connection: !ref db
table: orders           # tables orders_runs and orders_entries; default telo_durable
```

What changes:

- **Claiming is real.** Taking a run is one conditional `UPDATE`, so several
  replicas each running a resumer never both continue the same run.
- **Waking is prompt.** A delivery `NOTIFY`s on `<prefix>_wake` and a resumer
  `LISTEN`s, so an approval reaches the run in milliseconds instead of at the
  next poll. The interval is still what makes recovery *certain*; the wake only
  makes it fast.
- **Exactly-once becomes possible.** When a body's writes run inside a
  `Sql.Transaction` on the **same connection** the journal uses, the journal's
  own `INSERT` lands inside that transaction — a rollback discards the record
  along with the effect it described — and the step engine records the region
  step by step instead of collapsing it. Point the journal at a different
  database and the region is at-least-once again. Which way it resolved is a
  runtime fact, so every region logs one `durable.zone.mode` record
  (`collapsed` or `perStep`) and a run's result carries `collapsedRegions` and
  `collapseReasons`.

Operationally: the tables are created at boot when absent, tolerating two
replicas creating them at once; set `createTable: false` where your migrations
own them or the runtime user holds no DDL grant. Two journals on one database
need different `table:` prefixes, or each recovers the other's work.

## 7. What `telo check` catches

The static half reads the same call graph everything else does, so these are
reported before a run is ever started:

| Code | What it stops |
| --- | --- |
| `DURABLE_DETACH_FORBIDDEN` | A detached dispatch inside the body. Progress is recorded on completion, so detached work would be recorded as done while still running. Start a nested run instead. |
| `DURABLE_UNJOURNALABLE_RESULT` | A step whose target returns a stream. A live value cannot be written down; collect what you need into a plain value inside the step. |
| `DURABLE_NONDETERMINISM` | An impure call inside a region that re-runs whole. Pin it with `Durable.Value`. |
| `ZONE_ATTRIBUTE_VIOLATED` | A wait, or a retry long enough to park, inside a region that promises nothing inside it waits. |

## See also

- [`examples/durable-orders`](/examples) — the runnable version of this guide,
  with the kill-and-continue demo scripted.
- [Composing behaviour](/learn/composing-behaviour) — the step grammar this
  records.
- [Execution zones](/extend/execution-zones) — the mechanism behind
  `Durable.Idempotent` and the promises a region makes.
- [Durable execution specification](/reference/kernel/specs/durable-execution) —
  the normative contract a backend implements.
- The `durable`, `durable-local`, `durable-journal-file` and
  `durable-journal-postgres` modules on [hub.telo.run](https://hub.telo.run) —
  every field, and the engine's own docs on what is recorded.
