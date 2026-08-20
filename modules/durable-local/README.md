# durable-local

Durable execution with no engine to deploy.

A body of steps runs so that a crash and a restart continue where the work stopped: progress is recorded to a store you choose, and a poller picks up runs whose process died.

```yaml
imports:
  Durable: ../durable
  Local: ../durable-local
  Journal: ../durable-journal-file
---
kind: Journal.Journal
metadata: { name: runs }
directory: ./.telo/durable
---
kind: Local.Workflow
metadata: { name: onboard }
journal: !ref runs
runId: !cel "'onboard:' + inputs.email"
steps:
  - name: createAccount
    invoke: !ref accountTx
    retry: { attempts: 3 }
  - name: sendWelcome
    invoke: !ref sendMail
    inputs:
      to: !cel "inputs.email"
      accountId: !cel "steps.createAccount.result.id"
---
kind: Local.Resumer
metadata: { name: resumer }
workflow: !ref onboard
```

## What is here

| Kind | |
| --- | --- |
| `Local.Workflow` | Holds the body, records the run, replays what already happened. |
| `Local.Journal` | Where runs and their progress are stored (an abstract — a store implements it). |
| `Local.Resumer` | Polls for runs that stopped mid-flight, or whose wait is over, and continues them. |
| `Local.Deliver` | Wakes work waiting on a token, handing it the value it was waiting for. |
| `Local.Status` | What a run is doing right now, and what it is waiting on. |
| `Local.Result` | What a run produced, optionally waiting for it. |
| `Local.Cancel` | Calls a run off. |
| `Local.Schedule` | Records work to start at a later time. |
| `Local.Resume` | Forces held work to continue against the code deployed now. |

## What is recorded, and why it is more than the results

The obvious answer — "record what each step returned" — is **not enough**, and the gap is silent.

A step's inputs, a branch's predicate and a loop's condition are read from a scope that also carries live readings: a resource's observed state is republished on every dispatch by design. Re-deriving any of them in a fresh process can produce a different answer. The sharpest case has no error at all: a loop whose collection comes from a resource read returns a different order after a restart, index N now names a different element, and the recorded result for that position is handed to work it never described. Wrong results, no failure — the precise thing durability exists to prevent.

So **every decision is recorded too**: resolved inputs, each predicate, each loop condition, each switch key, each pure `value:` step. A resume feeds them back rather than recomputing them, which makes a replay a function of the record alone.

Recording the value rather than a checksum is deliberate. Checksum-and-detect is cheaper and equally good at *noticing*, and it is the wrong tool: observed state is defined as a live reading, so a run would fail on every resume where the world had moved — which it usually has. That is fragility with good error messages. Recording the value removes the failure instead of reporting it.

## Run identity

`runId:` is CEL over the call's inputs. Submitting the same id again **attaches** to the existing run rather than starting a second one, which is how an idempotent start is expressed — a completed run answers with what it produced. `onConflict: reject` fails instead. Omit `runId` and one is minted.

The run is recorded **before** anything executes. That ordering is what makes recovery possible at all: a process that dies between the two leaves a run with no progress, which the resumer finds and replays.

## The resumer is recovery, not scheduling

A start does its own first execution in the process that received it, so the resumer does not balance work across machines — it picks up runs whose process died. Routing every start through its poll interval would put seconds of latency on a request-triggered run for no gain in recovery.

It claims each run before continuing it, so several pollers against one store do not both take the same one. Resuming calls the workflow's own execution path: continuing an interrupted run and starting a fresh one are the **same** operation, because replay is what a resume is.

## A start does not wait, and reading the outcome is a separate ask

`Local.Workflow` returns as soon as the run is recorded:

```json
{ "runId": "onboard:ada@example.com", "started": true, "status": "running" }
```

That is not an omission — it is what waiting makes necessary. A body that parks for an approval does not return for days, so a start that waited for the outcome could not answer at all. An HTTP route that triggers a run therefore responds immediately while the body keeps going, and the process stays alive until the run finishes **or parks** (a parked run holds nothing, which is the whole point of parking).

A caller that genuinely wants the outcome asks for it:

```yaml
kind: Local.Result
metadata: { name: outcome }
journal: !ref runs
wait: 30s          # omit to answer immediately with whatever state it is in
```

Putting the choice here rather than on the start is what keeps both usable: the work never has to block anyone, and a caller that can afford to wait says so.

```json
{ "run": "onboard:ada@example.com", "status": "completed", "result": { … },
  "collapsedRegions": 0, "collapseReasons": [] }
```

`collapsedRegions` is the one to watch. A region wrapped in `Durable.Idempotent` — or a transaction whose records land outside its own atomicity — is recorded as one entry and **re-runs whole** on a resume. That is at-least-once, and whether you got it can depend on runtime facts the manifest cannot show, so the run says which way it resolved rather than leaving it to be inferred. `collapseReasons` carries the author's own sentence for each.

Each region also emits one `durable.zone.mode` record at the moment it resolves — the run, the providing kind, the attribute, and `mode: collapsed` or `mode: perStep`. Both outcomes, at the same level: `perStep` is the exactly-once regime and is reached by a runtime attestation, so the affirmative answer is worth as much as the negative, and collapse is the correct resolution under a journal on separate storage, so raising its level would warn on every development run. One field to filter a dashboard on.

The way to get `perStep` for a transactional region is a journal that writes into the same transaction — [`durable-journal-postgres`](../durable-journal-postgres/README.md) on the connection your writes use.

## Waking work that is waiting

A body waits with [`Durable.Sleep` or `Durable.Await`](../durable/README.md); this module supplies the other half.

```yaml
kind: Local.Deliver
metadata: { name: approve }
journal: !ref runs
# Naming the await checks `payload:` against the shape it declared — statically
# for a literal, and at runtime for what is actually sent. A delivery addressed
# from outside the manifest names nothing and is unchecked.
await: !ref approval
token: !cel "inputs.token"
payload:
  approvedBy: !cel "inputs.by"
```

**It takes the journal, not the workflow**, and that is what makes a delivery a *separate application's* operation: a webhook receiver has the store and nothing else, and requiring the workflow would make it depend on the body it is waking and on everything that body reaches.

**It does not continue the run.** The payload is written at the wait's own position — which makes it that step's result, with no second record to reconcile — and the resumer picks the run up on its next pass. That is what lets a delivery arrive in a process that will never execute the body.

A token that matches nothing answers `{ "delivered": false }` rather than failing. An approval clicked twice is an ordinary outcome of a public endpoint, not something to page on.

## Scheduling, and forcing work forward

`Local.Schedule` records work to start later — and unlike a cron firing, a scheduled run missed while the process is down is still found due on restart. It stores the values the work should start with, since there is no caller at the moment it begins.

`Local.Resume` exists for one situation: work held because the code changed underneath it. It clears the hold and **records the override** as a journal entry, because work continued against different code may diverge, and a divergent run has to be identifiable afterwards rather than indistinguishable from a clean one. Parking is a hold, not a grave.

## Limits, stated plainly

- **A resumer holds the process open** for as long as it polls, which is right for an app whose job is recovery and wrong for a one-shot script. Work is also continued by submitting the same run id again, which attaches, takes the lapsed claim and replays — the identical path.
- **A detached dispatch inside a body is rejected** by `telo check`. Progress is recorded when a step *completes*, so detaching would record work as done while it was still running — a resume would skip it and a crash would lose it.
- **A live value cannot be recorded.** A stream is produced by consuming it, so there is nothing to write down; collect what you need into a plain value inside the step.

## Further reading

- [What is recorded, and why it is more than the results](./docs/what-is-recorded.md) — the closure property, and the silent failure it closes.
- [Durable execution](../../kernel/specs/durable-execution.md) — the normative contract, including what a backend must guarantee.
- [durable](../durable/README.md) — `Durable.Idempotent` and the marker every backend extends.
- [durable-journal-file](../durable-journal-file/README.md) — a store on disk, for one machine.
- [durable-journal-postgres](../durable-journal-postgres/README.md) — a store in PostgreSQL, for several: real claiming, prompt waking, and records that can commit with the writes they describe.
