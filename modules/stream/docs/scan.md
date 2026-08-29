---
description: "Stream.Scan: accumulate a stream and emit the running state after every value — a fold that emits as it goes"
sidebar_label: Stream.Scan
---

# Stream.Scan

> Examples below assume this module is imported with an `imports:` entry under alias `Stream`. Kind references follow that alias — substitute your own if you import it under a different name.

Accumulates a stream and emits the running state **after every value**. A fold that
emits as it goes, rather than one value at the finish.

Reassembling text from deltas is the case it exists for: each delta is meaningless
alone, the accumulated text is what a reader wants, and it has to arrive per delta
rather than at the end. [`Collection.Fold`](../../collection/docs/fold.md) answers the
same question with a single value when the collection is exhausted — which, for a
stream, means never.

```yaml
- name: Assembled
  invoke:
    kind: Stream.Scan
    initial: ""
    accumulate: !cel "acc + item.delta"
  inputs:
    input: !cel "steps.Deltas.result.output"
```

## Fields

| Field | Type | Purpose |
| --- | --- | --- |
| `initial` | CEL | The starting accumulator, evaluated once before the first value. **Required.** |
| `accumulate` | CEL | The accumulator's next value, evaluated once per element. **Required.** |
| `emit` | CEL | What to emit for this element. Omitted, the accumulator itself is emitted. |
| `accType` | type ref | The running state's contract. Optional. |

`accumulate` **replaces** the accumulator rather than merging into it.

## What the expressions see

`acc` (the running state — typed from `accType` when you declare one), `item`, `index`
and `inputs`. `emit` is evaluated **after** `accumulate`, against the new accumulator,
so it describes the state this element produced rather than the one it replaced.

## Why `emit` is separate

The state and the value worth publishing are routinely different. A parser accumulates
a buffer and emits only the frames it completed:

```yaml
invoke:
  kind: Stream.Scan
  initial: { buffer: "", frames: [] }
  accumulate:
    buffer: !cel "splitLast(acc.buffer + item, '\\n')"
    frames: !cel "completeFrames(acc.buffer + item)"
  emit: !cel "acc.frames"
```

Folding the two together would force every consumer to carry the buffer it does not want.
