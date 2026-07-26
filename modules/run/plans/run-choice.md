# Run.Choice — declarative first-match decision

## Problem

Expressing a first-match decision — map an input to one of several typed
outcomes — has no clean home in `run`. `Run.Value` shapes a value but only via CEL
ternaries, which are unreadable past two branches. `Run.Sequence`'s `switch`
matches a value against equality *keys*, not arbitrary predicates. `if/elseif`
takes arbitrary predicates but executes side-effecting *steps*, not a pure value.
None give a pure, readable *first-match predicate → typed value* table — which is
what a routing rule, a pricing tier, or an authz policy all want.

## Solution

A new `Telo.Invocable` kind `Run.Choice` in the existing `run` module, sibling to
`Run.Value` / `Run.Sequence` / `Run.Iteration` (the declarative-logic family). It
declares a typed `inputs` contract (a JSON Schema property map, exactly like
`Run.Value`) and an ordered `choices` array. Each choice has:

- `when` — a CEL boolean predicate over `inputs`.
- `value` — a CEL expression, or a structure with `!cel` leaves, evaluated over
  `inputs` (the same field `Run.Value` uses for its produced value).

The first choice whose `when` is true wins; its `value` becomes the invoke result.
An optional `default` supplies a `value` when no choice matches; with no `default`
and no match, the call errors (never a silent null). CEL in `when`/`value` is
typed against `inputs` via `x-telo-context`, matching `Run.Value`.

### Typing the outcome

The point of the kind is *typed* outcomes, so the output contract is declared
**per instance**: an `outputType` field on the resource, an `x-telo-ref: "telo#Type"`
(the shape `Js.Script` already uses), not a fixed `outputType` on the
`Telo.Definition`. A definition-level type would be meaningless here — every
`Run.Choice` returns a different shape — and the analyzer's step-result resolution
reads the invoked *resource manifest's* own `outputType` first, so an
instance-level field is what actually makes a caller's
`!cel "steps.tier.result.cost"` type-check instead of falling back to permissive.

`outputType` is optional; when declared it is enforced in both halves:

- **Statically** — every choice's `value` and the `default`'s `value` are checked
  against it at analysis time, so a branch that returns the wrong shape is a
  `telo check` diagnostic rather than a runtime surprise on the one input that
  reaches it. This is the property nested CEL ternaries cannot give. The check
  is a new generic annotation, `x-telo-value-schema-from: "<field>"` — not
  kind-specific analyzer code — so any definition with a declared type and
  several value-producing slots can adopt it.
- **At runtime** — the produced value is AJV-checked, as the backstop for
  dynamically-shaped branches the static pass cannot fully resolve (a `!cel`
  leaf over an untyped input satisfies any slot statically).

With no `outputType` the result is untyped to callers, exactly as `Run.Value`'s is
today.

Controller: a new export in the existing `@telorun/run` package (`nodejs/`).

## Decisions

- **A kind in `run`, not a new module** — it is the same declarative-logic family
  as `Value`/`Sequence`/`Iteration`, and `run` is already the home for
  declarative execution. Rejected: a standalone `decision`/`rules` module.
- **Name `Run.Choice`** — value-driven: it hands back one chosen value. Rejected:
  `Decision`/`Switch` (control-flow flavored), `Cond` (reads as a condition/`if`),
  `Branch` (reads as code that carries logic), `Match` (reads as `switch`).
- **Row field `value`, not `then` or `outputs`** — `then` already means "steps to
  execute" in `Run.Sequence`'s `if` (an intra-module clash if reused for a
  value); `outputs` is plural and conflates the per-row result with the resource's
  output contract; `value` matches `Run.Value`'s produced-value field and keeps
  the family consistent. Rejected: `then`, `outputs`, `result`.
- **Instance-level `outputType`, statically enforced across branches** — a
  first-match table's value is that all rows agree on one shape; checking that
  only at runtime means a mistyped branch ships and fails on the input that
  happens to select it. Declaring the type on the resource (not the definition) is
  also what lets downstream `steps.<name>.result` chains type-check. Rejected: a
  definition-level `outputType` (one fixed shape for every instance — unusable);
  runtime AJV alone (loses the static guarantee the kind is sold on); inferring a
  union from the branches (unpredictable diagnostics, and no contract for a caller
  to read).
- **First-match, not scored/priority** — manifest order *is* the priority;
  simplest and matches the `cond`/`switch` mental model.
- **No-match without `default` is an error** — never silently return null; the
  author handles the exhaustive case, consistent with the repo's null-safety and
  no-swallow stances.

## Usage after the change

A shipping-cost tier as a readable decision — each row is one legible
`when → value`, and every row is checked against the declared outcome shape:

```yaml
kind: Run.Choice
metadata:
  name: shippingTier
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
      cost: 0
  - when: !cel "inputs.order.weight > 20"
    value:
      tier: freight
      cost: !cel "inputs.order.weight * 2"
default:
  value:
    tier: standard
    cost: 10
```
