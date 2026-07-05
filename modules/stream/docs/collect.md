---
description: "Stream.Collect: consume a Stream fully and return its items as an array — the inverse of Stream.Of"
sidebar_label: Stream.Collect
---

# Stream.Collect

> Examples below assume this module is imported with an `imports:` entry under alias `Stream`. Kind references follow that alias — substitute your own if you import it under a different name.

Consumes a `Stream` to completion and returns every item as `items`, in order — the terminal **sink** and inverse of [`Stream.Of`](./of.md) (`Of`: array → stream; `Collect`: stream → array). It's the telo-native way to drain a stream and inspect it, instead of an inline `JS.Script`.

Draining is a side effect: consuming the stream runs its producer (an `Ai.AgentStream` turn, a pipeline), so `Stream.Collect` both **drives** the upstream work and **materializes** the result for a later step to assert on or aggregate in CEL.

```yaml
- name: Turn
  invoke: !ref Assistant          # Ai.AgentStream → { output: stream }
  inputs: { prompt: "…" }
- name: Events
  invoke: { kind: Stream.Collect }
  inputs:
    input: !cel "steps.Turn.result.output"
- name: Check
  inputs:
    usedTool: !cel "steps.Events.result.items.exists(r, r.type == 'tool-call')"
    text: !cel "steps.Events.result.items.filter(r, r.type == 'text-delta').map(r, r.delta).join('')"
  invoke: !ref Assert
```

`items` is a plain array of the observed elements (opaque — the same value-agnostic contract as every Telo stream), so CEL macros (`exists`, `filter`, `map`, `join`, indexing) work over it directly.

## Buffering

Buffered — every item is held in memory, bounded by the stream's length. Fine for finite streams (an agent turn, an HTTP response, a file read). For an unbounded stream, drain it incrementally (e.g. pipe through a codec to the response) rather than collecting.
