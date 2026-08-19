# What is recorded, and why it is more than the results

The obvious model of durable execution is "write down what each step returned, and skip those on a resume". That model is **not enough**, and the way it fails is silent.

## The scope a step reads is not the record

A step's `inputs:`, an `if:` predicate, a `while:` condition and a `switch:` key are all CEL, evaluated against a scope that carries far more than the accumulated step results:

- `resources.<name>` snapshots,
- `resources.<name>.status` — observed state, **republished on every dispatch by design**,
- provider values, `variables`, `secrets`.

Every one of those can answer differently in a fresh process, against freshly-created resources, hours later. So re-deriving a decision on a resume is not a neutral optimisation; it is asking a different question and accepting whatever comes back.

## The failure that has no error

The sharpest case produces no diagnostic at all:

```yaml
- name: fetchBatch
  invoke: !ref listPending      # returns rows in whatever order the query gives
- name: process
  invoke: !ref handleEach
  inputs:
    item: !cel "steps.fetchBatch.result.rows[0]"
```

Crash after `process` completes. On resume, `fetchBatch` returns its **recorded** rows — fine. But if the collection had instead been re-derived, row 0 would now be a *different row*, while the journal still holds a result filed under the same key, produced against the same target. Nothing mismatches. The run reports success over work that was done to the wrong record.

That is the failure durability exists to prevent, arriving through the door durability left open.

## So decisions are recorded too

Every decision point the grammar has is written down on first execution and returned verbatim on replay:

| Recorded | Which expression |
| --- | --- |
| `inputs` | a step's resolved `inputs:`, and the run's own `inputs:` |
| `predicate` | `if:` / `elseif:` / a step's `when:` |
| `condition` | `while:`, once per turn |
| `switch` | the `switch:` key |
| `value` | a pure `value:` step's expression |

Replay is then a function of `(journal, manifest)` alone. That **closure** is the property everything else rests on, and it is what makes the design survive additions: a new scope variable or a new provider kind years from now is covered without anyone re-auditing a list of "things that might move".

## Why record the value and not a checksum

Checksum-and-detect is cheaper and just as good at *noticing* a change. It is the wrong tool here, and the reason is a definition rather than a trade-off: **observed state is defined as a live reading**. A run that failed whenever a reading had moved would fail on nearly every resume, because that is what those readings do. You would have fragility with excellent error messages.

Recording the value removes the failure instead of reporting it.

## Where the run's own inputs live

The workflow's `inputs:` is CEL over the call that started the run — and a resume has no such call: the invocation that received it went with the process. So the resolved inputs are recorded at the root key `inputs`, and a resume reads them back. Without that, `!cel "inputs.email"` would quietly evaluate to nothing on every resumed run, and every step reading it would run against empty values.

Step paths are all `steps/`-prefixed, so a root key cannot collide with one.

## Nested bodies

A step whose target has a step body of its own — a sequence, a wrapped region —
records under the step that dispatched it:

```
steps/reserve
steps/reserve/announce
steps/reserve/work
steps/charge
steps/charge/announce
```

So a crash inside a nested body resumes **inside** it, at the one step of it that
had not finished, rather than re-running the whole thing.

The nesting is what keeps the keys distinct, and that is not cosmetic: a nested
body that started its own paths at the root would record `steps/work` for every
body in the run. Two nested bodies with a same-named step would then share one
key — and since the first record wins, the second would be handed the first's
*result*. Where both dispatch the same target there is nothing to detect, and the
run simply continues with a value produced for a different step.

## What this costs

One record per decision, on top of one per step. For an ordinary body that is a handful of small writes. For a hot loop it is not, which is what [`Durable.Idempotent`](../../durable/README.md) is for: wrap a region whose re-execution is genuinely a no-op and the whole region becomes one record — *and* its decisions stop being recorded, because the region re-runs wholesale by its own claim.

That is also why an impure expression inside such a region is a `telo check` error: the region promised re-running was a no-op, and `uuidv4()` makes that false.
