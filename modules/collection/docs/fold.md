---
description: "Collection.Fold: accumulate a collection into one value with author-defined state — running balances, greedy allocations, state machines over an event list."
sidebar_label: Collection.Fold
---

# `Collection.Fold`

> Examples below assume this module is imported with an `imports:` entry under alias `Collection`. Kind references (`Collection.Fold`) follow that alias — if you import the module under a different name, substitute your alias accordingly.

`Collection.Fold` walks a collection carrying **state you define**, applying a CEL step to the running accumulator once per element. It is the general form of [`Collection.Summarize`](operations.md#collectionsummarize), whose aggregator vocabulary is fixed at `sum` / `avg` / `min` / `max` / `size`: a fold expresses what those cannot, because each element sees what the previous ones produced.

Reach for it when the answer depends on the order of the elements and on what has accumulated so far — a running balance, a greedy allocation across records, a dedupe that remembers what it has seen, a state machine over an event list. `Run.Projection` maps but carries nothing between elements; `Run.Loop` carries state but dispatches a body, so a pure calculation pays a resource, a span and a topology node per step.

## Fields

| Field | Description |
| --- | --- |
| `collection` | CEL expression resolving to the array to fold over. Sees `inputs`. |
| `initial` | The starting accumulator. Sees `inputs`. |
| `accumulate` | The accumulator's next value, evaluated once per element. Sees `acc`, `item`, `index`, `items`, `inputs`. **Replaces** the accumulator rather than merging into it. |
| `while` | Optional predicate evaluated **before** each element; the fold stops at the first element for which it is false. Same scope as `accumulate`. |
| `value` | The result, projected from the finished accumulator. Sees `acc`, `items`, `inputs`. Write `!cel "acc"` when the accumulator is already the result. |
| `accType` | Optional contract for the intermediate state. |
| `outputType` | Optional contract for the result. |

`initial`, `accumulate` and `value` are unconstrained value slots: a pure `!cel` expression, a structure with `!cel` leaves, or a literal. A scalar accumulator is as expressible as a record one.

## Allocating a payment across invoices

```yaml
kind: Collection.Fold
metadata: { name: AllocatePayment }
collection: !cel "inputs.invoices"
accType:
  kind: Telo.JsonSchema
  schema:
    type: object
    additionalProperties: false
    required: [remaining, allocations]
    properties:
      remaining: { type: number }
      allocations: { type: array }
outputType:
  kind: Telo.JsonSchema
  schema:
    type: array
    items:
      type: object
      required: [invoice, applied]
      properties:
        invoice: { type: string }
        applied: { type: number }
initial:
  remaining: !cel "inputs.amount"
  allocations: []
while: !cel "acc.remaining > 0.0"
accumulate:
  remaining: !cel "acc.remaining - min([acc.remaining, item.due])"
  allocations: !cel "acc.allocations + [{'invoice': item.id, 'applied': min([acc.remaining, item.due])}]"
value: !cel "acc.allocations"
# 25.00 over invoices due 10 / 30 / 5
#   -> [ { invoice: a, applied: 10 }, { invoice: b, applied: 15 } ]
```

The third invoice is never visited: `while` is checked **before** each element, so a fold that stops "once the balance is exhausted" does not consume the element that would overdraw it.

## A scalar accumulator

```yaml
kind: Collection.Fold
metadata: { name: RunningTotal }
collection: !cel "inputs.amounts"
accType:
  kind: Telo.JsonSchema
  schema: { type: number }
initial: 0.0
accumulate: !cel "acc + item"
value: !cel "acc"
# -> 10.0
```

`value` is required even when the accumulator is already the result. That keeps
the output contract attached to exactly one slot, and stops a `value:` left
blank from quietly becoming a null result (it fails at load instead).

## The two contracts

They are independent, both optional, and each buys a different check:

- **`accType` types the intermediate state.** `acc` is typed from it inside `while`, `accumulate` and `value` — so `acc.<typo>` is a `CEL_UNKNOWN_FIELD` — and **both** `initial` and `accumulate` are held to it at analysis time. A step that drops a required field is an error before the fold runs, and so is a seed that never had it. Nothing is validated per element: an AJV pass in the inner loop of a pure calculation would cost more than it catches.
- **`outputType` types the result for callers.** `steps.<name>.result.<field>` type-checks at every consumer, and the produced value is validated at dispatch (`ERR_OUTPUT_INVALID`).

Declare neither and everything stays permissive — declaring one is what opts in.

What the static half covers is worth stating precisely, because it differs
between the two. A **written structure** — a map with `!cel` leaves, a literal —
is checked against its contract at analysis time: a missing required property, an
unknown property under `additionalProperties: false`, a literal of the wrong
type. A slot written as **one whole expression** (`value: !cel "acc"`) is not:
nothing in Telo compares a CEL expression's result type against a declared
contract, so `outputType` is enforced for that shape at dispatch. `accType` is
the same, which is why it is worth declaring — it types `acc`, and every
structured `initial` / `accumulate` is then held to it.

## Termination

The iteration count is bounded by the collection's length, and `while` can only shorten the run. That bound is why this is a fold and not a general recursion or function kind: recursion is unbounded and unanalyzable, a fold is neither.

## Result shape

Unlike its siblings — which return `{ rows }`, `{ items }`, `{ chunks }`, `{ summary }` — `Collection.Fold` returns the value itself. Their result shapes are fixed, which is what lets them wrap; a fold's is the author's. A fixed `{ value: … }` wrapper would have to be restated inside any `outputType` an author declares (contracts replace rather than merge), and without one every consumer would read `result.value.<field>` untyped.

## Errors

| Code | Cause |
| --- | --- |
| `INVALID_COLLECTION` | `collection` did not resolve to an array. |
| `ERR_INVALID_PREDICATE` | `while` evaluated to something other than a boolean. |
| `INVALID_VALUE` | `value` was written blank. Raised at load, not per call. |
| `ERR_OUTPUT_INVALID` | The produced value does not satisfy the declared `outputType`. |
