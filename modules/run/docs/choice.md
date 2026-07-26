---
description: "Run.Choice: a first-match decision table — ordered when → value rows that return one typed value, replacing unreadable nested CEL ternaries."
sidebar_label: Run.Choice
---

# `Run.Choice`

> Examples below assume this module is imported with an `imports:` entry under alias `Run`. Kind references (`Run.Choice`) follow that alias — if you import the module under a different name, substitute your alias accordingly.

`Run.Choice` is a `Telo.Invocable` that maps its `inputs` to **one value** by walking an ordered table of predicates. The first row whose `when` is true wins and its `value` becomes the result. It is pure: no steps, no side effects, no dispatch.

Routing rules, pricing tiers, authorization policies, and status mappings are all this shape.

## Why it exists

`Run.Value` can branch, but only through nested CEL ternaries — which stop being readable at the second arm:

```yaml
kind: Run.Value
metadata: { name: ShippingTier }
inputs:
  order: {}
value:
  tier: !cel "inputs.order.total >= 100 ? 'free' : (inputs.order.weight > 20 ? 'freight' : 'standard')"
  cost: !cel "inputs.order.total >= 100 ? 0.0 : (inputs.order.weight > 20 ? inputs.order.weight * 2.0 : 10.0)"
```

The same decision as a table — one legible row per outcome, and the predicate stated once instead of repeated per output field:

```yaml
kind: Run.Choice
metadata: { name: ShippingTier }
inputs:
  order: {}
choices:
  - when: !cel "inputs.order.total >= 100"
    value:
      tier: free
      cost: 0.0
  - when: !cel "inputs.order.weight > 20"
    value:
      tier: freight
      cost: !cel "inputs.order.weight * 2.0"
default:
  value:
    tier: standard
    cost: 10.0
```

## Fields

| Field | Purpose |
| --- | --- |
| `inputs` | The input **contract**: a JSON Schema property map (name → schema), NOT values. `{}` declares an untyped (dyn) input. Rows read them as `!cel "inputs.<name>"`. |
| `choices` | Ordered decision rows, each `{ when, value }`. The first row whose `when` is true wins; no later row is evaluated. At least one row is required. |
| `default` | `{ value }` produced when no row matches. Omit it to make a non-exhaustive table an error. |
| `outputType` | Optional named or inline type every row's `value` must satisfy. |

## Ordering is the priority

There are no weights or scores — manifest order decides. When more than one row matches, the earlier one wins:

```yaml
choices:
  # An order over 100 that also weighs 30kg ships free: this row is first.
  - when: !cel "inputs.order.total >= 100"
    value: { tier: free, cost: 0.0 }
  - when: !cel "inputs.order.weight > 20"
    value: { tier: freight, cost: 60.0 }
```

## Declaring the outcome type

`outputType` gives every row one shared result contract. Declaring it is what lets a caller's `!cel "steps.<name>.result.<field>"` type-check — without it the result is untyped downstream, exactly like `Run.Value`'s.

```yaml
kind: Run.Choice
metadata: { name: ShippingTier }
inputs:
  order: {}
outputType:
  kind: Type.JsonSchema
  schema:
    type: object
    required: [tier, cost]
    additionalProperties: false
    properties:
      tier: { type: string }
      cost: { type: number }
choices:
  - when: !cel "inputs.order.total >= 100"
    value:
      tier: free
      cost: 0.0
default:
  value:
    tier: standard
    cost: 10.0
```

Declaring it also turns the table's rows into a checked contract, in both halves:

**Statically** — `telo check` validates every row's `value` and the `default`'s `value` against `outputType`, *including rows no current input would select*. A branch that disagrees is rejected before it can ever win:

```
error  Run.Choice/BadRow: `choices[1].value` does not satisfy the type declared
       at `outputType`: / is missing required property 'cost'  SCHEMA_VIOLATION
```

This is the property nested CEL ternaries cannot give: there, a mistyped arm ships and fails on whichever input first reaches it.

**At runtime** — the produced value is validated too, catching what static analysis cannot see through. A `!cel` leaf reading an untyped (dyn) input satisfies any slot statically, but its actual value may not; that fails with `ERR_OUTPUT_INVALID`, naming the row (`choices[0].value`) rather than the resource as a whole.

The static half is generic rather than special-cased for this kind: the `value` slots carry `x-telo-value-schema-from: outputType`, an annotation any definition with a declared type and several value-producing slots can adopt.

## Exhaustiveness

A table with no matching row and no `default` throws `ERR_NO_MATCH`. It never returns null — a silent null is exactly the failure that turns into an unexplained downstream error three steps later. Add a `default:` when the fallback is a real outcome; leave it off when a missed case is a bug you want surfaced.

```yaml
- name: classify
  try:
    - name: pick
      invoke: !ref Tier
      inputs: { order: !cel "inputs.order" }
  catch:
    - name: report
      invoke: !ref LogUnclassified
```

## Errors

| Code | Cause |
| --- | --- |
| `ERR_NO_MATCH` | No row matched and no `default` is declared. |
| `ERR_INVALID_PREDICATE` | A row's `when` evaluated to something other than a boolean. A truthy string or number is an authoring mistake in a decision table, not a match. |
| `ERR_OUTPUT_INVALID` | The winning row's `value` does not satisfy the declared `outputType`. |

## `Run.Choice` vs the alternatives

| Use | When |
| --- | --- |
| `Run.Choice` | A pure first-match **value** from arbitrary predicates. |
| `Run.Value` | One value with no branching (or a single ternary). |
| `Run.Sequence` `switch` | Matching one value against equality **keys**, then running steps. |
| `Run.Sequence` `if` / `elseif` | Arbitrary predicates that select **steps to execute** (side effects), not a value. |

## Numbers: int vs double

CEL distinguishes integers from doubles and does not implicitly promote between them. A value arriving through a contract is a double, so multiply by a double literal or cast with `double(...)`:

```yaml
- when: !cel "inputs.order.weight > 20"
  value:
    cost: !cel "inputs.order.weight * 2.0"
```
