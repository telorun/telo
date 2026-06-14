---
description: "Run.Iteration: run a step body once per element of a collection, for side-effects, with bounded concurrency."
sidebar_label: Run.Iteration
---

# `Run.Iteration`

> Examples below assume this module is imported with an `imports:` entry under alias `Run`. Kind references (`Run.Iteration`) follow that alias — if you import the module under a different name, substitute your alias accordingly.

`Run.Iteration` is a `Telo.Runnable` that runs its `steps` body **once per element** of a collection, for side-effects. It produces no collected result (use [`Run.Projection`](./projection.md) when you need the per-element values). The body is the same step grammar as [`Run.Sequence`](../README.md) — `invoke`, `if`, `switch`, `try`, `throw` — minus the `while` block (the kind is itself the loop).

## Fields

| Field | Description |
| --- | --- |
| `collection` | CEL expression resolving to the array iterated over. |
| `steps` | The body run once per element. |
| `concurrency` | Maximum elements processed at once. Default `1` (strictly ordered); `>1` runs that many in flight. |
| `inputs` | Input contract (JSON Schema property map); the body reads them as `!cel "inputs.x"`. |
| `catches` | Whole-operation error contract — see [Error handling](#error-handling). |

## Body scope

Inside `steps`, three variables are bound in addition to `inputs`:

- `item` — the current element.
- `index` — the element's 0-based position (integer).
- `items` — the whole collection.

`item` is **typed automatically** from `collection`'s element type when it is statically known — e.g. a `collection` of `!cel "inputs.users"` where the `inputs` contract types `users` as an array makes `item.<unknownField>` a static error. When the element type can't be inferred (a list literal, a computed expression), `item` is permissive. `steps.<name>.result` is statically typed from each step's invoked resource, exactly as in `Run.Sequence`.

```yaml
kind: Run.Iteration
metadata:
  name: NotifyUsers
collection: !cel "inputs.users"
concurrency: 10
steps:
  - name: send
    invoke: !ref SendEmail
    inputs:
      to: !cel "item.email"
      n: !cel "index"
```

## Concurrency

`concurrency: 1` (the default) runs elements strictly in order. A higher value runs that many elements concurrently. Execution is **fail-fast**: when an element throws and is not caught inside its own body, no further elements are scheduled and the error propagates.

## Error handling

Two levels, no overlap:

- **Per-element** — wrap the element's work in an inline `try/catch` inside `steps` (sees `item`/`index`). This is where you skip or recover a single bad element and keep the batch going.
- **Whole-operation** — the kind-level `catches` list maps a throw that escapes the **entire** iteration to a fallback result. Each entry is `{ when, value }`; `when` is a CEL condition over `error` and `inputs`. An unmatched throw propagates.

```yaml
kind: Run.Iteration
metadata:
  name: NotifyUsers
collection: !cel "inputs.users"
steps:
  - name: guarded
    try:
      - name: send
        invoke: !ref SendEmail
        inputs:
          to: !cel "item.email"
    catch:
      - name: report
        invoke: !ref LogFailure
        inputs:
          user: !cel "item"
          error: !cel "error.message"
```
