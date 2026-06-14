---
description: "Run.Projection: transform each element of a collection through a step body and collect the results into an array, in order, with bounded concurrency."
sidebar_label: Run.Projection
---

# `Run.Projection`

> Examples below assume this module is imported with an `imports:` entry under alias `Run`. Kind references (`Run.Projection`) follow that alias — if you import the module under a different name, substitute your alias accordingly.

`Run.Projection` is a `Telo.Invocable` that runs its `steps` body **once per element** of a collection and collects each element's `outputs` into an array — the declarative map over a collection. Input order is preserved even under concurrency. For pure side-effects with no collected result, use [`Run.Iteration`](./iteration.md).

The body is the same step grammar as [`Run.Sequence`](../README.md) minus the `while` block (the kind is itself the loop).

## Fields

| Field | Description |
| --- | --- |
| `collection` | CEL expression resolving to the array projected over. |
| `steps` | The body run once per element. |
| `outputs` | A CEL map evaluated per element; its value is collected into the result array. Omit to collect the raw step map. |
| `concurrency` | Maximum elements processed at once. Default `1` (strictly ordered); `>1` runs that many in flight. |
| `inputs` | Input contract (JSON Schema property map). |
| `catches` | Whole-operation error contract — see [Error handling](#error-handling). |

## Body scope

Inside `steps` and `outputs`, three variables are bound in addition to `inputs`:

- `item` — the current element.
- `index` — the element's 0-based position (integer).
- `items` — the whole collection.

`item` is **typed automatically** from `collection`'s element type when it is statically known (e.g. a `collection` of `!cel "inputs.ids"` whose contract types `ids` as an array), so `item.<unknownField>` is a static error; otherwise it is permissive. `steps.<name>.result` is statically typed from each step's invoked resource.

```yaml
kind: Run.Projection
metadata:
  name: EnrichIds
collection: !cel "inputs.ids"
concurrency: 8
steps:
  - name: fetch
    invoke: !ref FetchRecord
    inputs:
      id: !cel "item"
outputs:
  id: !cel "item"
  name: !cel "steps.fetch.result.name"
# result -> [ { id, name }, ... ]  (input order preserved)
```

## Concurrency

`concurrency: 1` (the default) processes elements in order. A higher value runs that many concurrently; the result array still follows input order. Execution is **fail-fast** — an uncaught element throw stops scheduling and propagates.

## Error handling

- **Per-element** — inline `try/catch` inside `steps` (sees `item`/`index`); recover a single element, e.g. emit a fallback value from a `catch` branch.
- **Whole-operation** — the kind-level `catches` list maps a throw that escapes the **entire** projection to a fallback result. Each entry is `{ when, value }` with `when` a CEL condition over `error` and `inputs`. An unmatched throw propagates.

```yaml
catches:
  - when: !cel "error.code == 'RATE_LIMITED'"
    value: []
```
