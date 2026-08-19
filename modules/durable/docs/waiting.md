# Waiting

A durable body can stop and wait — for a time, or for something delivered from
outside — and the process is free to go away while it does. That is the
difference between waiting here and calling `sleep`, and it is what makes work
measured in days ordinary rather than exotic.

## What a wait actually does

The run records where it stopped and stops executing. Nothing is held: no
connection, no timer, no process. The application may exit, be redeployed, and
pick the work up somewhere else. When the wait is over — a deadline passes, a
delivery arrives — the run is picked up and **replays**: every step that already
finished returns its record instead of running again, and execution continues at
the step that was waiting.

That replay is why the steps before the wait must be recorded, and it is why an
effect that is not recorded happens twice.

## Waiting for a time

```yaml
kind: Durable.Sleep
metadata: { name: cooldown }
for: 24h
```

Or `until:` for a deadline that is a property of the data rather than of when
the wait started.

**The wake time is pinned on the first pass.** Re-deriving it on a resume would
push the deadline forward by however long the process was down, so a 72-hour
wait that crashed at hour 71 would restart at 72. Recording it once makes the
deadline a property of the work rather than of whichever process happens to be
running it.

## Waiting for a delivery

```yaml
kind: Durable.Await
metadata: { name: approval }
token: !cel "'approve:' + inputs.ticket"
outputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [approvedBy]
    additionalProperties: false
    properties:
      approvedBy: { type: string }
      note: { type: string }
```

**The token is the address.** Write one when something has to hand it out
*before* the wait starts — an approval email carries the link, and the step that
sends it runs first. Omit it and one is generated, for the case where the
address is handed out by whatever reads the work rather than by the work itself.
Either way it is recorded, so every resume waits on the same address.

**`outputType:` is not optional in practice.** What a delivery carries is a
property of *this* wait and of no other, so it is declared here — and without it
the steps reading `steps.approval.result.approvedBy` type-check against nothing.

**A deadline is per call as well as per instance.** `timeout:` on the resource
sets a default; `inputs.timeout` at a step overrides it, so one await can serve
two sites that wait different lengths.

It is **pinned when the wait begins**, like a sleep's wake time and for a sharper
reason: a deadline recomputed on every resume slides forward by however long each
wait lasted, so a 72-hour timeout would never be reached and `timeout:` would
silently mean nothing. When it does pass with nothing delivered, the work fails
with `ERR_DURABLE_AWAIT_TIMEOUT` — an author who declared a deadline declared
that going unanswered is a failure, and returning an empty value would look like
an answer to every step after it.

## The delivering side is native

There is no shared "deliver" kind, and that is deliberate. Waking a run is a
journal write on one backend, an awakeable resolution on another, a signal on a
third — genuinely different operations, and a shared contract over them would be
the union of three lifecycles with each backend losing the half that did not
generalize.

What ties the halves together is a **reference**, not a second contract: a
backend's deliver kind takes an `await:` ref and checks its payload against that
instance's declared `outputType`. The shape is declared once, here, and checked
where it is produced.

**The check happens at the delivery, and that is the only place it can.** A
delivered value enters the record without ever being dispatched — a replay hands
it back as the wait's result rather than re-entering the wait — so nothing
downstream ever looks at it. Naming the wait is what opts into both halves: the
static check on a literal payload, and a runtime check on the value actually
sent. It is also where the failure is actionable, since the caller who sent the
wrong shape is still on the phone.

A delivery that names no await — a token addressed from outside the manifest —
has no declaration to check against and is unchecked by construction.

## Where waiting is forbidden

Some regions promise that nothing inside them waits:

- a **transaction** holds a connection, and a body that parked would resume in a
  process where neither the connection nor the transaction exists;
- a **lease** expires on its own clock, so a body that parked would resume after
  another holder had already been granted the same key.

Both say so in the manifest, in their own words. Putting a wait inside one is a
`telo check` error that prints the region's promise beside the wait's rebuttal:

```
Durable.Await 'approval' is inside a Lease.Critical 'guarded' region that
declares 'noSuspend' (the lease expires on its own TTL and is renewed only
while this body runs, so a body that parked here would resume after another
holder had already been granted the same key), but Durable.Await cannot honour
it: this waits for a delivery from outside the run, which may be days away…
```

The runtime refuses too — the static check can only see the paths it can trace,
so it is early warning rather than containment.

**A long retry backoff is the same hazard wearing different clothes.** Above 30
seconds a retry waits by parking rather than by sleeping, which is what makes a
long backoff free; it is also what makes it illegal inside a region that cannot
be held open. Shorten it, or move the retry outside the region so it re-attempts
the region as a whole.

## Waiting inside a fan-out

`Run.Iteration` and `Run.Projection` take a `concurrency:`, so several branches
can be in flight when one of them waits. **The branch parks, not the region.**
Its siblings keep running, the fan-out settles every one of them — finished,
failed, or waiting — and only then does the whole region stop.

Tearing the siblings down on the first park would be worse than slow: a step is
recorded when it *completes*, so an interrupted sibling has no record and re-runs
whole on resume. Parallel fan-out would be routinely at-least-once. Nothing new
was needed to get this right — each branch's positions are already
index-qualified, so each branch is already independently resumable.

## What must not swallow a wait

A wait unwinds the stack to the work that owns the run, so a `try:` step, a
`catches:` list and a retry policy all let it pass rather than treating it as a
failure.

Those are the three that are known. The signal also passes through every other
controller in between, and any one of them with a `catch (e)` that swallows
what it does not recognise would convert a wait into a completed step and
duplicate every effect after it. Enumerating them is impossible and would go
stale on the next module, so the failure is **detected** instead: the wait is
latched when it is raised, and work that returns normally with one latched is a
hard error naming what waited and where. If you write a controller, rethrow what
you did not recognise.

## Further reading

- [Collapsing a region](./collapsing-a-region.md) — and `Durable.Value`, which is
  what keeps an impure expression honest inside one.
- [durable-local](../../durable-local/README.md) — the delivering, scheduling and
  cancelling half for the local backend.
- [Durable execution](../../../kernel/specs/durable-execution.md) — the normative
  contract, including the conformance rules a backend keeps.
