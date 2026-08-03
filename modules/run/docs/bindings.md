---
description: "Named CEL bindings and pure steps: name the intermediate values of a calculation without a resource, a dispatch, or a JS.Script."
sidebar_label: Bindings & pure steps
---

# Bindings and pure steps

> Examples below assume this module is imported with an `imports:` entry under alias `Run`. Kind references (`Run.Value`) follow that alias — if you import the module under a different name, substitute your alias accordingly.

A calculation with intermediate values used to have no declarative form. Four derived values meant one nested unreadable expression, or four `Run.Value` resources chained through a `Run.Sequence` — four dispatches, four spans, four topology nodes, four names in module scope, for arithmetic. Two constructs close that, one per place the intermediates live.

## `bindings:` — inside a pure expression kind

`Run.Value` and `Run.Choice` take an optional `bindings:` map. Each entry names a value; every name is then readable **by bare name** inside the kind's expressions and inside the other bindings.

```yaml
kind: Run.Value
metadata: { name: PriceLine }
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [qty, unitPrice, discountRate, taxRate]
    properties:
      qty: { type: number }
      unitPrice: { type: number }
      discountRate: { type: number }
      taxRate: { type: number }
bindings:
  net: !cel "gross - discount"
  gross: !cel "inputs.qty * inputs.unitPrice"
  discount: !cel "gross * inputs.discountRate"
value:
  net: !cel "net"
  tax: !cel "net * inputs.taxRate"
```

**Order is derived, not declared.** `net` is written first and reads two bindings declared after it; what orders them is the references, not the manifest. That is why `bindings:` is a map and `steps:` is a list — a map says order carries no meaning, so reordering rows (or an editor rewriting them) can never change behaviour. A binding that reaches itself, directly or through others, is a `BINDING_CYCLE` error at `telo check`.

**Evaluation is lazy and memoised per call.** A binding is computed on first read, at most once; one that nothing reads is never computed at all. That makes a binding exactly equivalent to inlining its expression at each use site — a refactoring, not a change in what runs. It matters most in a decision table:

```yaml
kind: Run.Choice
metadata: { name: ShippingTier }
bindings:
  weight: !cel "sum(inputs.items.map(i, i.grams)) / 1000.0"
choices:
  - when: !cel "weight > 30.0"
    value: { tier: freight }
  - when: !cel "weight > 2.0"
    value: { tier: parcel }
default:
  value: { tier: letter }
```

`weight` is computed once for the whole call however many rows read it — and not at all if no row that runs needs it.

**Names may not shadow the scope.** A binding named `inputs`, `resources`, `variables`, `secrets`, `ports`, `steps` or `error` is a `BINDING_NAME_RESERVED` error: at runtime a scope variable always wins, so such a binding would silently never be read. Rename it.

**Types flow where they can.** A binding whose expression is a plain path into a typed value (`inputs.order`) carries that value's schema, so `order.<typo>` under it is a `CEL_UNKNOWN_FIELD`. Anything else — arithmetic, a call, a comprehension — is left open rather than guessed.

## A pure step — inside a sequence or a body

Bindings are evaluated before any step runs, so they cannot see `steps.*`. For an intermediate derived from a step's result, a step carries `value:` instead of `invoke:`:

```yaml
kind: Run.Sequence
metadata: { name: Checkout }
steps:
  - name: cart
    invoke: !ref LoadCart
    inputs: { id: !cel "inputs.cartId" }
  - name: total
    value: !cel "sum(steps.cart.result.lines.map(l, l.price * double(l.qty)))"
  - name: charge
    invoke: !ref ChargeCard
    inputs:
      amount: !cel "steps.total.result"
      customer: !cel "steps.cart.result.customerId"
```

`total` publishes `steps.total.result` exactly as an invoke step does, so nothing downstream can tell how the value was produced — but it dispatches nothing: no resource, no span, no topology node. The step form is part of the shared step grammar, so it works in `Run.Sequence`, `Run.Loop`, `Run.Iteration` and `Run.Projection`, and inside their `if` / `switch` / `try` branches. In a body kind it also sees that kind's scope (`item`, `index`, `items`, `iteration`, `previous`).

Its result is typed permissively — there is no dispatch target whose contract could describe it — so read it into a step whose `inputType` declares the shape when you want it checked.

## Which one

| You need | Use |
| --- | --- |
| An intermediate inside `Run.Value` / `Run.Choice` | `bindings:` |
| A value shared by several decision rows | `bindings:` |
| An intermediate derived from a step's result | a `value:` step |
| A value used once, in one expression | neither — write it inline |
