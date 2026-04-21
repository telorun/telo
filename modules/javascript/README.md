---
description: "JavaScript.Script: inline per-request computation with main function contract, typed inputs/outputs, and async support"
---

# JavaScript

Inline JavaScript executed by the kernel. Use `JavaScript.Script` for per-request compute that is too complex for a CEL expression but does not warrant a dedicated controller — input transforms, response shaping, ad-hoc arithmetic, glue logic inside a `Run.Sequence`.

`JavaScript.Script` is a `Telo.Invocable` — it exposes an `invoke(inputs)` contract and is callable from any invocable slot (HTTP handlers, sequence steps, workflow nodes, etc).

---

## The script contract

The `code` field must define a `main` function. The kernel calls it with the invocation inputs and uses the returned value as the result.

```yaml
kind: JavaScript.Script
metadata:
  name: Add
code: |
  function main({ a, b }) {
    return { sum: a + b };
  }
```

- `main` may be `async` — the kernel awaits its return.
- The returned value is the full result; property access (`result.sum`) works downstream.
- Throwing an `Error` surfaces as an invocation error through the normal `Run.Sequence` `try/catch` flow.

---

## Typed inputs and outputs

`inputType` and `outputType` accept either an inline JSON Schema or a named `Type.JsonSchema` reference. They drive analyzer validation and the editor's autocomplete — the runtime itself also validates inputs before `main` runs.

```yaml
kind: JavaScript.Script
metadata:
  name: Normalize
inputType:
  type: object
  properties:
    email: { type: string }
  required: [email]
outputType:
  type: object
  properties:
    normalized: { type: string }
code: |
  function main({ email }) {
    return { normalized: email.trim().toLowerCase() };
  }
```

Or reference a named type:

```yaml
kind: Type.JsonSchema
metadata:
  name: Email
schema:
  type: object
  properties:
    email: { type: string }
  required: [email]
---
kind: JavaScript.Script
metadata:
  name: Normalize
inputType: Email
code: |
  function main({ email }) {
    return { normalized: email.trim().toLowerCase() };
  }
```

---

## Using it in a sequence

```yaml
kind: Run.Sequence
metadata:
  name: PriceItem
steps:
  - name: compute
    invoke:
      kind: JavaScript.Script
    inputs:
      quantity: "${{ inputs.quantity }}"
      unitPrice: "${{ inputs.unitPrice }}"
    code: |
      function main({ quantity, unitPrice }) {
        const net = quantity * unitPrice;
        return { net, gross: net * 1.23 };
      }
outputs:
  total: "${{ steps.compute.result.gross }}"
```

---

## Notes

- The Node.js controller compiles `code` via `new Function`. Scripts run in the host's global scope — they are **not** sandboxed. Treat `JavaScript.Script` as application code, not a trust boundary.
- `require` and ESM `import` are not available (the code is a `Function` body, not a module). `process`, `Buffer`, and other globals are reachable if needed.
- Scripts are compiled once at resource creation and reused across invocations, so avoid per-call top-level work — put state setup inside `main` if it depends on inputs.
- For heavier logic (third-party libraries, typed models, shared helpers) write a dedicated controller package instead.
