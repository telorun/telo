# Collapsing a region

By default **everything is recorded**: every step's outcome, every decision. `Durable.Idempotent` is how you buy that back for a region where the recording costs more than it saves.

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

One record for the whole region instead of one per step.

## The rule has no fields in it

> A region collapses when **re-running it is safe** — because its effects are discarded together, or because re-running is a no-op.

You do not say "collapse this". You say what is *true of the region*, and collapse follows. Three kinds declare that property, differing in whether they **enforce** it or **assert** it:

| | Property | Who guarantees it |
| --- | --- | --- |
| `Sql.Transaction` | effects discarded together | the database |
| `Idempotency.Once` | re-running is a no-op | its claim — the settled result is replayed |
| `Durable.Idempotent` | re-running is a no-op | **you** |

Reaching for the third is a cost decision, and it stays visible in the manifest as a different kind rather than as a boolean on one.

## Why the default is the expensive direction

The opposite polarity — record nothing unless asked — was rejected because forgetting is silent. A step whose recording you forgot re-executes on resume, charging the card twice, and nothing reports it. Forgetting to *collapse* costs some writes.

An earlier design had a caller-side "collapse this" plus a callee-side veto. It was wrong four ways at once: a boolean where every neighbouring annotation carries a reason; the wrong polarity, so forgetting to veto was silent; a veto available on one kind only, leaving a collapsed script unprotected; and a contradiction check to reconcile it with transactional atomicity.

A region with a property is a zone, and zones already express that. So the veto does not move — it **disappears**. Nothing collapses your body because nothing wrapped it, and a wrap is a visible resource carrying a written justification.

## `reason:` is required, as prose

There is no `true` to write. Whatever reports on the region quotes your sentence:

```
collapsedRegions: 1
collapseReasons: ["Durable.Idempotent (idempotent): every write is an upsert keyed on
                   the source id, so a re-run overwrites itself"]
```

An operator asking "why is this at-least-once" reads that. A claim with no stated basis is the one shape nobody can review.

## What collapse does not suppress

Collapse stops the engine recording *its own* per-step entries inside the region. It does not silence the journal: a resource inside the region that records directly still does. That is what lets a value-pinning kind work inside a collapsed region rather than be a prescription with nowhere to write.

## The check that keeps the claim honest

An impure expression inside an idempotent region is `DURABLE_NONDETERMINISM`, an error:

```yaml
inputs:
  key: !cel "uuidv4()"        # ← rejected inside Durable.Idempotent
```

The region re-runs with its earlier effects **intact** — nothing discarded them — so a fresh id writes record A on the first pass and record B on the second. The re-run is not a no-op and the claim you signed is false.

The **same expression in an ordinary durable step is fine**: it is recorded once and replayed identically, which is exactly what a durable identifier should be. That is why the rule keys on the idempotent property and not on durability in general — firing there would have authors rewriting correct manifests.

## `atomic` is a separate attribute, deliberately

`atomic` means *effects are discarded together*, and it collapses **unless** the recorder attests its own writes land inside that atomicity — when they do, per-step recording is consistent by construction and strictly better. `idempotent` rolls nothing back, so there is nothing for a recorder to be inside; it collapses unconditionally. Borrowing one name for both would make an attestation relax collapse for a region whose effects will genuinely re-run.
