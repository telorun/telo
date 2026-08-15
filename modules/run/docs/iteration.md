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
| `collection` | CEL expression resolving to the array **or stream** iterated over. A stream is pulled lazily — see [Iterating a stream](#iterating-a-stream). |
| `steps` | The body run once per element. |
| `concurrency` | Maximum elements processed at once — an integer literal or a `!cel` expression (sees `inputs`). Default `1` (strictly ordered); `>1` runs that many in flight. |
| `inputType` | Input contract — a `Telo.JsonSchema` shape, a named type reference, or an inline schema. The body reads the values as `!cel "inputs.x"`. |
| `catches` | Whole-operation error contract — see [Error handling](#error-handling). |

## Body scope

Inside `steps`, these variables are bound in addition to `inputs`:

- `item` — the current element.
- `index` — the element's 0-based position. A CEL integer is an int64, so it composes with integer literals directly: `!cel "index + 1"` needs no cast.
- `items` — the whole collection. Bound **only when the collection is an array** (see below).

`item` is **typed automatically** from `collection`'s element type when it is statically known — e.g. a `collection` of `!cel "inputs.users"` where the `inputs` contract types `users` as an array makes `item.<unknownField>` a static error. A stream is typed the same way, from the `of` argument of its `Telo.Stream` annotation. When the element type can't be inferred (a list literal, a computed expression), `item` is permissive. `steps.<name>.result` is statically typed from each step's invoked resource, exactly as in `Run.Sequence`.

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

## Iterating a stream

`collection` accepts a byte or record **stream** as well as an array. A stream is pulled lazily — one element at a time per worker, never read ahead — so a source too large to hold in memory can still be iterated. Pairs with [`Stream.Chunk`](../../stream/docs/chunk.md) for a chunked upload.

```yaml
collection: !cel "steps.Chunks.result.output"
concurrency: 1
```

**`items` is not in scope under a stream.** There is no materialized collection to expose: the only value the binding could hold is the cursor this loop is pulling from, and handing it to a step's `inputs:` is an ordinary pass-through no rule catches — the step could drain the loop's own source and end the iteration early, silently.

Referring to `items` where the collection resolves to a stream is a static error. The analyzer withholds the binding, so the diagnostic is the generic `CEL_UNKNOWN_FIELD` — `'items' is not defined (available: … inputs, item, index, steps)` — rather than one explaining that it was withheld deliberately.

Where the collection's type cannot be resolved statically (a comprehension, a `filter(...)`), the analyzer stays quiet and the binding is decided at runtime: `items` is bound only when the expanded collection really is an array. A stream there simply leaves the name unbound, and a body referring to it fails when the expression is evaluated — the enforcement is that a live cursor is never bound on any path, not that the failure is well-labelled.

## Concurrency

`concurrency: 1` (the default) runs elements strictly in order. A higher value runs that many elements concurrently. The value may be an integer literal or a `!cel` expression over `inputs` (e.g. `!cel "inputs.workers"`); it must resolve to an integer ≥ 1 or the iteration fails with `INVALID_CONCURRENCY`. Execution is **fail-fast**: when an element throws and is not caught inside its own body, no further elements are scheduled and the error propagates.

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
