# durable

Work that survives process death, backend-neutral.

A body of steps whose progress is recorded as it runs, so a crash and a restart continue where the work stopped instead of repeating every effect or losing them all. This module supplies the pieces a body uses whatever engine is underneath; an **engine module** supplies the recording and the resumption.

Today that engine is [`durable-local`](../durable-local/README.md), which needs nothing deployed.

## What is here

| Kind | |
| --- | --- |
| `Durable.Run` | A marker. A backend's workflow kind extends it; kinds that only make sense inside a durable run name it as the region they require. |
| `Durable.Idempotent` | Wraps a body you assert is safe to re-run, so a recorder keeps one record for the whole region instead of one per step. |
| `Durable.Sleep` | Waits for a duration, or until a time, surviving restarts in between. |
| `Durable.Await` | Waits for a value delivered from outside the run — an approval, a webhook, a human decision. |
| `Durable.Value` | Records the result of an expression once and returns the same value on every re-run. |

## `Durable.Run` is a marker, and deliberately nothing else

It declares no schema, no controller and no contract. Its entire job is to give the kinds that must be inside a durable run **one kind to require**, after which Liskov acceptance — an entry satisfies a requirement when its kind is, or transitively extends, the required kind — makes every backend's workflow kind satisfy it for free, with no per-backend rule anywhere.

Giving it a schema or a controller would immediately start re-accumulating a union surface: identity policy, schedule overlap, cancel-versus-terminate, deployment pinning. Every engine has an opinion about each, and they do not agree. That is why there is no shared `start` / `cancel` / `status` here — those are exactly where engines differ, and flattening them costs fidelity in both directions.

## `Durable.Idempotent` — collapsing a region

**Everything is journaled by default.** Forgetting to record an effectful step re-executes it on a resume, which is the failure nobody notices, so the burden sits on the cheap case instead.

What this kind buys is the other direction: a region you know is safe to re-run needs *one* record rather than one per step. Reach for it in a hot loop where a durable claim per iteration would cost more than the records it saves.

```yaml
kind: Durable.Idempotent
metadata: { name: importAll }
reason: every write is an upsert keyed on the source id, so a re-run overwrites itself
steps:
  - name: fetch
    invoke: !ref source
  - name: write
    invoke: !ref upsert
```

`reason:` is required, and required as **prose rather than as a boolean**. Whatever reports on this region quotes it — an operator asking "why is this at-least-once" reads your sentence — and a claim with no stated basis is the one shape nobody can review.

**It is a kind, not a field**, and that is the whole point. The field version was a caller-side "collapse this" plus a callee-side veto, and it was wrong four ways at once: a boolean where every neighbouring annotation carries a reason; the opposite polarity from everything-journaled-by-default, so forgetting to veto was silent; a veto available on one kind only, leaving a collapsed script unprotected; and a contradiction check to reconcile it with transactional atomicity. A region with a property is a zone, and zones already express that — so the veto does not move, it **disappears**: nothing collapses your body because nothing wrapped it, and a wrap is a visible resource carrying a written justification.

### Asserted, not earned

`Durable.Idempotent` takes your word. [`Idempotency.Once`](../idempotency/README.md) makes the same claim about its region and *enforces* it — the claim settles the key with the body's result, so a second execution replays it. Both declare the same property because the region's property is the same; which one you reach for is a cost decision, and it stays visible in the manifest as a different kind rather than as a boolean on one.

**Impure expressions inside are a `telo check` error** (`DURABLE_NONDETERMINISM`). An idempotent region re-runs with its earlier effects *intact* — nothing discarded them — so a `uuidv4()` inside it writes record A on the first pass and record B on the second, and the claim you signed is false. The same expression in an ordinary durable step is fine: it is recorded once and replayed identically, which is what a durable identifier should do.

## Waiting

Three kinds wait or pin, and all three **name nothing**: no run reference, no backend import. They reach the run they are executing inside off the invocation context, so the same document works under every engine — each installs its own recording before dispatching the body.

```yaml
kind: Durable.Sleep
metadata: { name: cooldown }
for: 24h
---
kind: Durable.Await
metadata: { name: approval }
# The address a delivery must carry. Write one when something has to hand it out
# BEFORE the wait starts — an approval email carries the link, and the step that
# sends it runs first. Omit it and one is generated.
token: !cel "'approve:' + inputs.ticket"
# What the delivery carries. Per instance, because that is what it is: without
# it the steps reading this result would type-check against nothing.
outputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [approvedBy]
    properties:
      approvedBy: { type: string }
```

**Waiting releases the process.** A parked run holds nothing: the application may exit, be redeployed, and pick the work up in a different process days later. That is the difference between this and a `sleep` — and it is why a wait measured in days is an ordinary thing to write here.

**The delivering side is native.** There is no shared "deliver" kind, because waking a run is genuinely different per engine — a [`DurableLocal.Deliver`](../durable-local/README.md), a Restate awakeable, a Temporal signal. What ties the two halves together is a reference, not a second contract: a backend's deliver kind takes an `await:` ref and checks its payload against *that instance's* `outputType`.

### Waiting where waiting is forbidden

Some regions promise that nothing inside them waits — a transaction holds a connection, a lease expires on its own clock. Putting a wait inside one is a `telo check` error (`ZONE_ATTRIBUTE_VIOLATED`) that prints both sentences: the region's promise and the wait's rebuttal, each in its author's own words. The runtime refuses too (`ERR_DURABLE_SUSPEND_FORBIDDEN`), because the static check can only see the paths it can trace.

The same rule catches a **retry whose backoff is long enough to park** — above 30 seconds a retry waits by parking rather than by sleeping, which is what makes a long backoff free, and what makes it illegal inside a region that cannot be held open.

## `Durable.Value` — pinning one impure evaluation

Redundant everywhere except the one place it is essential. An ordinary `value:` step is recorded already; inside a **collapsed** region — a `Durable.Idempotent`, or a transaction whose records land outside its atomicity — nothing per-step is recorded, because the region re-runs whole. A `uuidv4()` there yields a different value the second time and falsifies the region's own claim.

```yaml
kind: Durable.Value
metadata: { name: batchId }
value: !cel "uuidv4()"
```

Collapse suppresses per-step records, never the recording itself, so this replays where everything around it does not. It is what makes `DURABLE_NONDETERMINISM`'s advice something you can act on.

## Further reading

- [Waiting](./docs/waiting.md) — what a wait actually does, where it is forbidden, and what must not swallow it.
- [Collapsing a region](./docs/collapsing-a-region.md) — when one record is enough, and the check that keeps the claim honest.
- [Durable execution](../../kernel/specs/durable-execution.md) — the normative contract.
- [Execution zones](https://telo.run/extend/execution-zones) — the mechanism `Durable.Idempotent` declares through.
