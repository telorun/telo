# durable

Work that survives process death, backend-neutral.

A body of steps whose progress is recorded as it runs, so a crash and a restart continue where the work stopped instead of repeating every effect or losing them all. This module supplies the pieces a body uses whatever engine is underneath; an **engine module** supplies the recording and the resumption.

Today that engine is [`durable-local`](../durable-local/README.md), which needs nothing deployed.

## What is here

| Kind | |
| --- | --- |
| `Durable.Run` | A marker. A backend's workflow kind extends it; kinds that only make sense inside a durable run name it as the region they require. |
| `Durable.Idempotent` | Wraps a body you assert is safe to re-run, so a recorder keeps one record for the whole region instead of one per step. |

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

## Further reading

- [Collapsing a region](./docs/collapsing-a-region.md) — when one record is enough, and the check that keeps the claim honest.
- [Durable execution](../../kernel/specs/durable-execution.md) — the normative contract.
- [Execution zones](https://telo.run/extend/execution-zones) — the mechanism `Durable.Idempotent` declares through.
