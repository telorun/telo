---
description: "Run.Value: a declarative invocable that returns a CEL-evaluated value (or a constant) — the declarative way to shape data, with no script."
sidebar_label: Run.Value
---

# `Run.Value`

> Examples below assume this module is imported with an `imports:` entry under alias `Run`. Kind references (`Run.Value`) follow that alias — if you import the module under a different name, substitute your alias accordingly.

`Run.Value` is a `Telo.Invocable` whose result is a CEL expression — or a structure with CEL leaves, or a plain constant — evaluated over the caller's `inputs`. It is how a handler **shapes a value**: string concatenation, field mapping, arithmetic, or returning a fixed literal. No I/O, no branching, no Node API — those belong in `Run.Choice`, a `Run.Sequence`, or a purpose-built resource kind.

## Why it exists

A handler that only concatenates a string needs no code. `Run.Value` expresses it declaratively, so the analyzer type-checks it and the editor can render it:

```yaml
kind: Run.Value
metadata: { name: MakeId }
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    properties:
      seed: { type: string }
value:
  documentId: !cel "'drawings/' + inputs.seed + '.png'"
```

## Fields

| Field | Purpose |
| --- | --- |
| `inputType` | The input **contract** — a `Telo.JsonSchema` shape, a named type reference, or an inline schema. The `value` expression reads the values as `!cel "inputs.<name>"`. Optional — a constant needs none. |
| `bindings` | Optional named intermediate values, readable by bare name inside `value` and by each other. Order is derived from what each one references; each is computed at most once per call, and only if something reads it. See [Bindings and pure steps](./bindings.md). |
| `value` | A CEL expression, a structure (map / array) with CEL leaves, or a plain literal. Evaluated at invoke time over `inputs` and any `bindings`; the result is what callers receive and may be any shape (object, array, scalar). |

Like `Run.Sequence`, the `inputs:` field is the contract (what the resource accepts), distinct from the `inputs:` a caller passes at invoke time (the values).

## Shaping a value (object result)

```yaml
kind: Run.Value
metadata: { name: Multiplier }
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    properties:
      a: { type: number }
      b: { type: number }
value:
  product: !cel "inputs.a * inputs.b"
```

## A constant (no inputs, any shape)

`value` can be a plain literal — useful for fixtures and stub tools. Here it returns an array of multimodal content parts:

```yaml
kind: Run.Value
metadata: { name: Snapshot }
value:
  - { type: text, text: page rendered }
  - { type: image, data: aGVsbG8=, mediaType: image/png }
```

## As a tool, a step, or a handler

Because it is a plain `Telo.Invocable`, `Run.Value` composes anywhere an invocable is accepted — an `Ai.Tools` entry, a `Run.Sequence` step, an `Http.Api` handler:

```yaml
kind: Ai.Tools
metadata: { name: GreetTools }
tools:
  - tool: !ref Greeter
    name: greet
    description: Greet someone by name.
    parameters:
      type: object
      required: [who]
      properties: { who: { type: string } }
    inputs:
      target: !cel "arguments.who"
    result: !cel "result.greeting"
---
kind: Run.Value
metadata: { name: Greeter }
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    properties:
      target: { type: string }
value:
  greeting: !cel "'Hello, ' + inputs.target + '!'"
```

## Numbers: int vs double

CEL distinguishes integers from doubles and does not implicitly promote between them. A number nothing declares as an integer — an argument a contract leaves untyped, for instance — arrives as a double, so multiplying it by an integer literal fails with `no overload of "*" takes (double, int)`. Use a double literal, or cast with `double(...)`. A value declared `type: integer`, and an integral number written literally in a parent step's `value:`, is already an int and needs no cast.

```yaml
value:
  doubled: !cel "double(inputs.n) * 2.0"
```

## Naming the steps of a calculation

A `value` with four derived quantities in it does not need four resources — declare them as `bindings:` and read them by name:

```yaml
bindings:
  gross: !cel "inputs.qty * inputs.unitPrice"
  discount: !cel "gross * inputs.discountRate"
value:
  net: !cel "gross - discount"
```

See [Bindings and pure steps](./bindings.md) for the ordering, laziness and shadowing rules.

## When NOT to use `Run.Value`

`value` is pure CEL, but "pure CEL" covers more than it sounds: the CEL catalog already has `parseJson` / `json`, `base64Encode` / `base64Decode`, `sha256` / `sha1` / `sha512` / `hmac`, `uuidv4` / `uuidv7`, `nowIso` / `today`, `regexGroups` / `regexExtractAll`, `sum` / `avg` / `min` / `max`, and `sort` / `distinct` / `flatten` / `range`. Branching is [`Run.Choice`](./choice.md), mapping is [`Run.Projection`](./projection.md), and aggregation lives in the `collection` module.

What is left for a dedicated resource kind is a Node.js API the kernel does not expose: `fetch`, `Buffer` / byte-level inspection, streams, a native library.
