# JavaScript

Inline JavaScript executed by the kernel. `JavaScript.Script` is a `Telo.Invocable` for per-request compute that is too complex for a CEL expression but does not warrant a dedicated controller.

## Deprecated

`JavaScript.Script` is deprecated. It still runs, unchanged, and existing manifests keep working — but declaring it now reports a `DEPRECATED_KIND` warning at the resource's `kind:` line in `telo check` and in the editor.

A body of JavaScript is opaque to every guarantee the rest of the runtime rests on: it cannot be type-checked, and it cannot be rendered in a visual editor.

There is no single replacement, because what replaces a script depends on what the script does:

- **Shaping a value, choosing a branch, iterating** — the `Run` kinds (`Run.Value`, `Run.Choice`, `Run.Iteration`, `Run.Projection`) with CEL, which the analyzer type-checks.
- **Reaching an API nothing else exposes** — write a resource kind. That is the case the escape hatch existed for, and a kind makes the capability reusable, statically analyzable and available to every consumer instead of one manifest.

## Why use this

- **Invocable anywhere** — usable from HTTP handlers, sequence steps, workflow nodes, or any invocable slot.
- **Typed inputs and outputs** — `inputType` / `outputType` accept inline JSON Schema or a named `Type.JsonSchema`; the runtime validates inputs before `main` runs.
- **Async-aware** — `main` may be `async`; the kernel awaits the return value.
- **Structured errors** — thrown `Error`s surface through the normal `Run.Sequence` `try/catch` flow.

## Kinds

| Kind | Purpose |
| --- | --- |
| `JavaScript.Script` | Run an inline `main({ ... })` JavaScript function as an invocable resource. |

## Example

```yaml
kind: JavaScript.Script
metadata:
  name: Add
inputType:
  type: object
  properties:
    a: { type: number }
    b: { type: number }
  required: [a, b]
outputType:
  type: object
  properties:
    sum: { type: number }
code: |
  function main({ a, b }) {
    return { sum: a + b };
  }
```

## The script contract

The `code` field must define a `main` function. The kernel calls it with the invocation inputs and uses the returned value as the result.

- `main` may be `async` — the kernel awaits its return.
- The returned value is the full result; property access (`result.sum`) works downstream.
- Throwing an `Error` surfaces as an invocation error through the normal `Run.Sequence` `try/catch` flow.

## Typed inputs and outputs

`inputType` and `outputType` accept either an inline JSON Schema or a named `Type.JsonSchema` reference. They drive analyzer validation and the editor's autocomplete — the runtime itself also validates inputs before `main` runs.

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
      quantity: !cel "inputs.quantity"
      unitPrice: !cel "inputs.unitPrice"
    code: |
      function main({ quantity, unitPrice }) {
        const net = quantity * unitPrice;
        return { net, gross: net * 1.23 };
      }
outputs:
  total: !cel "steps.compute.result.gross"
```

## Notes

- The Node.js controller compiles `code` via `new Function`. Scripts run in the host's global scope — they are **not** sandboxed. Treat `JavaScript.Script` as application code, not a trust boundary.
- `require` and ESM `import` are not available (the code is a `Function` body, not a module). `process`, `Buffer`, and other globals are reachable if needed.
- Scripts are compiled once at resource creation and reused across invocations, so avoid per-call top-level work — put state setup inside `main` if it depends on inputs.
- For heavier logic (third-party libraries, typed models, shared helpers) write a dedicated controller package instead.
