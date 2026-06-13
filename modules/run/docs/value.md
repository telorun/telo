---
description: "Run.Value: a declarative invocable that returns a CEL-evaluated value (or a constant) — the type-safe replacement for a Js.Script that only shapes data."
sidebar_label: Run.Value
---

# `Run.Value`

> Examples below assume this module is imported with an `imports:` entry under alias `Run`. Kind references (`Run.Value`) follow that alias — if you import the module under a different name, substitute your alias accordingly.

`Run.Value` is a `Telo.Invocable` whose result is a CEL expression — or a structure with CEL leaves, or a plain constant — evaluated over the caller's `inputs`. It is the declarative replacement for a `JS.Script` that only **shapes a value**: string concatenation, field mapping, arithmetic, or returning a fixed literal. No I/O, no branching, no Node API — those still belong in `JS.Script` (or a purpose-built resource kind).

## Why it exists

A `JS.Script` like this isn't really JavaScript — it concatenates a string:

```yaml
kind: JS.Script
metadata: { name: MakeId }
code: |
  function main({ seed }) {
    return { documentId: "drawings/" + seed + ".png" };
  }
```

`Run.Value` expresses the same thing declaratively, so the analyzer type-checks it, the editor can render it, and there is no JavaScript to audit:

```yaml
kind: Run.Value
metadata: { name: MakeId }
inputs:
  seed: { type: string }
value:
  documentId: "${{ 'drawings/' + inputs.seed + '.png' }}"
```

## Fields

| Field | Purpose |
| --- | --- |
| `inputs` | The input **contract**: a JSON Schema property map (name → schema), NOT values. `{}` declares an untyped (dyn) input. The `value` expression reads them as `${{ inputs.<name> }}`. Optional — a constant needs no inputs. |
| `value` | A CEL expression, a structure (map / array) with CEL leaves, or a plain literal. Evaluated at invoke time over `inputs`; the result is what callers receive and may be any shape (object, array, scalar). |

Like `Run.Sequence`, the `inputs:` field is the contract (what the resource accepts), distinct from the `inputs:` a caller passes at invoke time (the values).

## Shaping a value (object result)

```yaml
kind: Run.Value
metadata: { name: Multiplier }
inputs:
  a: { type: number }
  b: { type: number }
value:
  product: "${{ inputs.a * inputs.b }}"
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
      target: "${{ arguments.who }}"
    result: "${{ result.greeting }}"
---
kind: Run.Value
metadata: { name: Greeter }
inputs:
  target: { type: string }
value:
  greeting: "${{ 'Hello, ' + inputs.target + '!' }}"
```

## Numbers: int vs double

CEL distinguishes integers from doubles and does not implicitly promote between them. A value that flows in through a contract (e.g. a tool argument or a parent step) arrives as a double, so multiplying it by an integer literal fails with `no such overload: dyn<double> * int`. Use a double literal, or cast with `double(...)`:

```yaml
value:
  doubled: "${{ double(inputs.n) * 2.0 }}"
```

## When NOT to use `Run.Value`

`value` is pure CEL. Reach for `JS.Script` (or a dedicated resource kind) when the work needs:

- a Node.js API — `fetch`, `Buffer`/`Uint8Array`, `Date`, `Map`, streams, crypto;
- real branching, loops, or recursion that CEL can't express cleanly;
- parsing (`JSON.parse`) or byte-level inspection.
