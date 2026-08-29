---
description: "Stream.Map: transform every value of a stream with a CEL expression, one in and one out, as the consumer pulls"
sidebar_label: Stream.Map
---

# Stream.Map

> Examples below assume this module is imported with an `imports:` entry under alias `Stream`. Kind references follow that alias — substitute your own if you import it under a different name.

Transforms every value of a stream with a CEL expression: one value in, one value out.
The usual reshaping stage — a wire record becomes whatever the next stage expects.

```yaml
- name: Frames
  invoke: { kind: Sse.Decoder }
  inputs:
    input: !cel "steps.Response.result.body"
- name: Parsed
  invoke:
    kind: Stream.Map
    value:
      kind: !cel "item.event"
      payload: !cel "item.data"
  inputs:
    input: !cel "steps.Frames.result.records"
```

## Fields

| Field | Type | Purpose |
| --- | --- | --- |
| `value` | CEL | Each output value, evaluated once per element. **Required.** |
| `elementType` | type ref | The contract each produced value satisfies. Optional. |

## Inputs / Output

`input` is the stream to transform; `output` is the transformed stream.

## What the expression sees

`item` (the current value), `index` (its zero-based position) and `inputs` (the call's
own inputs).

## Lazy, and abandonable

The work happens as the consumer pulls — nothing is drained to build a result, so a
token stream arrives token by token rather than all at once at the end.

A consumer that stops draining causes `for await` to call `return()` on this stage,
which propagates to its source and on to the transport. Every stage is a pass-through
by construction rather than by remembering to be one, so an abandoned pipeline really
does close the socket behind it.

## `elementType`

Declaring it holds `value` to that shape at analysis time, so a stage that drops a field
the next one reads is an error before it runs rather than a missing key at runtime.

```yaml
invoke:
  kind: Stream.Map
  elementType: !ref TokenPart
  value:
    type: !cel "item.event"
    delta: !cel "item.data"
```

Beware: a **whole-value** CEL expression at `value` (rather than a structure with `!cel`
leaves) is substituted by a schema-shaped placeholder before the check runs, so it
passes by construction. Write the structure out where you want the check to bite.
