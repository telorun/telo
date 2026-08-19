# Durable orders

Fulfilling an order in four steps, so that **killing the process half way and starting it again continues from where it stopped** — instead of charging the card a second time.

```bash
pnpm run telo examples/durable-orders/telo.yaml
```

Each step is slow on purpose, so there is time to interrupt it.

## The demo

Run it, and **hard-kill it** while it is charging:

```bash
pnpm run telo examples/durable-orders/telo.yaml &
sleep 5 && kill -9 %1
```

```
  reserving stock for order A-1…
  ✓ stock reserved
  charging card for order A-1…
                                    ← killed here
```

Look at what survived:

```bash
cat .telo/orders/*.ndjson
```

```
{"type":"run","run":"order:A-1","status":"running"}
{"type":"entry","entry":{"path":"steps/reserve/announce", …}}
{"type":"entry","entry":{"path":"steps/reserve/work", …}}
{"type":"entry","entry":{"path":"steps/reserve","kind":"step","value":{"reserved":true}, …}}
{"type":"entry","entry":{"path":"steps/charge/announce", …}}
```

`reserve` is there with its result. `charge` has only its *announce* — the charge itself never finished, so nothing recorded it. The run is still `running`, because a process that disappeared is not a verdict on the work.

Now run it again:

```bash
pnpm run telo examples/durable-orders/telo.yaml
```

```
  ✓ card charged  ← the one you do not want to happen twice
  shipping order A-1…
  ✓ shipped
  emailing the customer…
  ✓ customer notified

Done — order A-1 finished, and the steps already recorded were not run again.
```

**Nothing about reserving stock is printed**, because that step was not re-run — its result came back from the record. And look closer at the charge: `✓ card charged` appears *without* `charging card…` before it. The run resumed **inside** the charge, at the one step of it that had not finished.

## Things to try

| | |
| --- | --- |
| `ORDER_ID=A-2 pnpm run telo examples/durable-orders/telo.yaml` | a different order is a different run, and executes from the top |
| run the same order twice more | the second says *finished* immediately — a caller-chosen run id is an idempotent start |
| `rm -rf .telo/orders` | start over |
| kill it during *shipping* instead | the charge is not repeated, which is the whole point |

## Why it works — three things worth knowing

**Records are written when a step COMPLETES, never when it is dispatched.** That is what makes an interrupted step re-run and a finished one not. Recording on dispatch would mark the charge done the instant it was *attempted*, and a kill one line later would skip it forever — the opposite of what you want.

**More than results are recorded.** A step's resolved inputs and every branch predicate are recorded too. They are read from a scope that includes live readings — a resource's observed state is republished on every dispatch by design — so re-deriving one in a fresh process can answer differently. The failure that would cause has no error attached to it: a loop whose collection came out in a different order would hand a recorded result to a different element, and nothing would notice. Recording the decision removes that rather than detecting it.

**Ctrl-C will not interrupt the run** — you need a hard kill. This surprises people, and it is deliberate: a durable run must outlive whatever triggered it, so it does not inherit the caller's cancellation. If it did, a run started by an HTTP request would be cancelled the moment the response went out. What *does* stop it is the process going away, which is exactly the case this feature exists for.

## The collapsed region

The last step is wrapped:

```yaml
kind: Durable.Idempotent
metadata: { name: notifyAtMostTwice }
reason: the mail is keyed on the order id, so a re-send replaces the queued copy
```

Everything is recorded by default; this wrap buys that back for a region where re-running is genuinely harmless, so the whole thing becomes **one** record instead of one per step. The `reason:` is required as prose because whatever reports on the region quotes it — an operator asking "why is this at-least-once?" reads your sentence, not a generic message.

You can see it in what the run reports: `collapsedRegions: 1`.

## Where the parts live

| | |
| --- | --- |
| [`durable`](../../modules/durable) | `Durable.Idempotent`, and the marker every backend extends |
| [`durable-local`](../../modules/durable-local) | the workflow, the journal contract, the resumer |
| [`durable-journal-file`](../../modules/durable-journal-file) | this demo's storage — append-only files, flushed per record |
| [spec](../../kernel/specs/durable-execution.md) | the normative contract |

Imports here are **relative paths** because these modules are not published yet. They become pinned `oci://` refs like every other example once they are.

## Not in this version

No suspension — there is no "wait three days for approval" yet. A run that cannot park can still crash and resume, which is what this demonstrates. Parking arrives with the kinds that express it.
