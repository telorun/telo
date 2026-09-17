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
| `collection` | the collection a composer iterates — `Run.Iteration`'s and `Run.Projection`'s `collection:` |

The last row is not the step engine's. A composer that drives its own body — an
iteration, a projection, a loop — evaluates its collection and its per-turn
condition *before* it hands a step list over, so it records them itself:
`Run.Iteration` and `Run.Projection` under `<dispatch>/collection`, and `Run.Loop`
under `<dispatch>/while[<turn>]`, beside the `<dispatch>[<turn>]` prefix each
turn's body records under. A step's `when:` guard is recorded under
`<step>/@when` — a segment no step name can spell, since the body that step
dispatches records its own steps directly under `<step>/`.

Replay is then a function of `(journal, manifest)` alone. That **closure** is the property everything else rests on, and it is what makes the design survive additions: a new scope variable or a new provider kind years from now is covered without anyone re-auditing a list of "things that might move".

## Why record the value and not a checksum

Checksum-and-detect is cheaper and just as good at *noticing* a change. It is the wrong tool here, and the reason is a definition rather than a trade-off: **observed state is defined as a live reading**. A run that failed whenever a reading had moved would fail on nearly every resume, because that is what those readings do. You would have fragility with excellent error messages.

Recording the value removes the failure instead of reporting it.

## A value comes back as the value it was

Recording *what* is only half of it; the other half is that a replayed value is the **same value**, CEL type included. Plain JSON is not that, and the ways it fails all look like success:

| First pass | Plain JSON replays it as |
| --- | --- |
| `timestamp('2026-01-15T09:30:00.250Z')` | a string — `now() - steps.t.result` has no overload for it |
| `9007199254740993` (an `int`) | a `double`, one digit short, silently |
| `duration('90m')` | a string — `.getSeconds()` is gone |
| bytes from `!include-bytes` | an object keyed by index |
| a map with `int` keys | a map keyed by text, so `m[2]` resolves to nothing |

So every recorded value is written as a **typed frame** — one schema-independent JSON form covering the whole CEL value domain, one-to-one in both directions — and each entry carries the codec version that wrote it (`v: 1`). The run record is written the same way: a scheduled run's `inputs`, which the resumer starts its body from, and a finished run's `result`, which `Local.Result` and an attaching start hand back — each beside its own codec version (`inputsCodecVersion`, `resultCodecVersion`). An object member holding no value — one a controller left unset, or a step in the result that produced nothing — is left out of whatever is recorded, exactly as plain JSON left it out, so it is neither refused nor replayed as something else. The frame is the engine's, not each store's: a journal keeps the version and the value together and never looks inside either, which is what makes the property hold for a store this repo did not write.

Two consequences an operator sees:

- **A journal written before this existed still resumes.** An entry or a run record with no version is read the way its store read one then — plain JSON, plus the `{"$bigint": …}` tag the SQL journals have always written for a wide integer. Refusing those would strand exactly the runs a journal exists to protect.
- **An entry written by a codec this runtime does not know is refused**, with `ERR_DURABLE_ENTRY_UNDECODABLE` naming the version, rather than read for the parts that look familiar. Continue that run on a runtime new enough to read its journal. A resumer that meets such a run — or one holding a value that does not decode, `ERR_DURABLE_JOURNAL_CORRUPT` — reports it once as an error naming the run and the code, leaves it `running`, and skips it from then on, so a runtime that can read it picks it up once the first claim lapses.
- **Stop every older worker before an upgraded one writes to a shared journal.** A runtime released before the codec version existed does not know to look for it: it reads a typed frame as the plain JSON text it is, and replays a step's value as that text — with no error. Only a runtime that reads the version can refuse an entry it does not understand, so a rolling upgrade across that boundary is not safe.

A value that is not a CEL value at all — a class instance (including one with a `toJSON`, which would come back as a plain object), a function, a live stream handle — is refused when it is recorded, with `ERR_DURABLE_UNJOURNALABLE_VALUE` naming where it was recorded and the field inside it. For a scheduled run's inputs that is the `Local.Schedule` call; for a run's result — reachable only through a step inside a collapsed region, whose result is not journaled on its own — the run settles `failed`.

A step whose target returns **nothing** is still journaled: the entry is what says it completed, and it simply carries no value. It replays as nothing, which is what the target returned.

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
