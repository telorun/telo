---
"@telorun/sdk": minor
---

`decideValue(ctx, invokeCtx, path, kind, compute)` is the single seam every durable decision point goes through — the step engine's `if` / `while` / `switch` / `value`, and a composer that drives its own body and therefore evaluates its collection or its per-turn condition before the engine ever sees a step list. Outside a durable run, and inside a collapsed region, it is `compute()` and nothing else.

`assertJournalable` now refuses everything the typed frame refuses, not only what `JSON.stringify` throws on. A class instance offering a `toJSON` stringified happily and replayed as a plain object — a value of a different type, with nothing reported anywhere — and is now `ERR_DURABLE_UNJOURNALABLE_VALUE`, carrying `data.valuePath`, the JSON Pointer of the offending node inside the value, beside the step path in `data.path`. A root `undefined` is not a value and is not refused: a step that produced nothing is journaled as an entry carrying no value. It returns the frame text it produced, so a backend records that rather than encoding the value a second time.

The recorded-value codec every backend follows is in the SDK beside the typed frame: `RECORDED_VALUE_CODEC_VERSION`, `writeRecordedValue(value, where)` (absent object members dropped, then `assertJournalable`), `withoutAbsentMembers` and `readRecordedValue(run, path, version, written)` — a value with no version read as its store read it before the codec, an unknown version refused with `ERR_DURABLE_ENTRY_UNDECODABLE`, and a frame that does not decode reported as `ERR_DURABLE_JOURNAL_CORRUPT` naming the run and path.

An invoke step's `when:` guard is journaled inside a durable run (`<step>/@when`, decision `predicate` — `GUARD_DECISION_SEGMENT`, a segment no step name can spell, so a step named `when` in the body the guarded step dispatches is not handed the guard's value), as a `try:` step's already was: re-derived on a resume, a guard reading a clock or observed state could turn false for a step whose effect had already happened, skipping it and leaving `steps.<name>` unset.
