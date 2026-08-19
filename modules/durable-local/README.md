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
| `Local.Resumer` | Polls for runs that stopped mid-flight and continues them. |

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

## What a run reports about itself

```json
{ "runId": "onboard:ada@example.com", "replayed": false, "collapsedRegions": 0, "collapseReasons": [], "result": { … } }
```

`collapsedRegions` is the one to watch. A region wrapped in `Durable.Idempotent` — or a transaction whose records land outside its own atomicity — is recorded as one entry and **re-runs whole** on a resume. That is at-least-once, and whether you got it can depend on runtime facts the manifest cannot show, so the run says which way it resolved rather than leaving it to be inferred. `collapseReasons` carries the author's own sentence for each.

## Limits, stated plainly

- **No suspension yet.** There is no "sleep for three days" or "wait for an approval": a body that cannot park can still crash and resume, which is what this version provides. Parking arrives with the kinds that express it.
- **A detached dispatch inside a body is rejected** by `telo check`. Progress is recorded when a step *completes*, so detaching would record work as done while it was still running — a resume would skip it and a crash would lose it.
- **A live value cannot be recorded.** A stream is produced by consuming it, so there is nothing to write down; collect what you need into a plain value inside the step.

## Further reading

- [What is recorded, and why it is more than the results](./docs/what-is-recorded.md) — the closure property, and the silent failure it closes.
- [Durable execution](../../kernel/specs/durable-execution.md) — the normative contract, including what a backend must guarantee.
- [durable](../durable/README.md) — `Durable.Idempotent` and the marker every backend extends.
- [durable-journal-file](../durable-journal-file/README.md) — the store this pairs with.
