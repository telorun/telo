---
description: "Stream.FlatMap: expand every value of a stream into any number of values — including none — flattened into one stream"
sidebar_label: Stream.FlatMap
---

# Stream.FlatMap

> Examples below assume this module is imported with an `imports:` entry under alias `Stream`. Kind references follow that alias — substitute your own if you import it under a different name.

Expands every value of a stream into **any number** of values, flattened into one
stream. This is what makes a stream's cardinality changeable, and both directions
matter on a real protocol: one wire frame routinely carries several logical records, and
a keep-alive or a terminator carries none.

```yaml
- name: Parts
  invoke:
    kind: Stream.FlatMap
    # A `[DONE]` sentinel expands to nothing; anything else to its parts.
    values: !cel "item.data == '[DONE]' ? [] : partsOf(item.data)"
  inputs:
    input: !cel "steps.Frames.result.records"
```

## Fields

| Field | Type | Purpose |
| --- | --- | --- |
| `values` | CEL → array | The values this element expands to. **Required.** |
| `elementType` | type ref | The contract each produced value satisfies. Optional. |

## What the expression sees

`item`, `index` and `inputs`.

## Emitting nothing

Return `[]`. Expressing "drop this" as an empty list is what removes the need for a
separate filter stage, and for a sentinel value meaning nothing.

## A non-array is refused

`values` must evaluate to an array; anything else raises `INVALID_VALUE` naming the
element's index. It is not wrapped as a single value, because that would make `values`
mean two things — a list to flatten, and a value to pass — kept apart only by what an
expression happened to return. A list-valued element would then flatten on one call and
not the next, with nothing to report it.
