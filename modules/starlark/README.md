---
description: "Starlark.Script: deterministic bounded Python-like scripting with run function contract and typed inputs/outputs"
---

# Starlark

Execute [Starlark](https://github.com/bazelbuild/starlark) code from a Telo resource. `Starlark.Script` reads inputs, runs the script, and returns its result.

Starlark is a deterministic, bounded subset of Python — useful when you want user-authored logic that you can execute without worrying about filesystem access, external network calls, or non-termination. If you trust the authored code and want full JavaScript power, use [`JavaScript.Script`](../javascript/README.md) instead.

---

## The script contract

The script must define a `run(input)` function. The controller calls it with the invocation inputs and uses the returned dict as the result.

```yaml
kind: Starlark.Script
metadata:
  name: ComputePrice
inputType:
  type: object
  properties:
    quantity: { type: integer }
    unitPrice: { type: number }
outputType:
  type: object
  properties:
    total: { type: number }
code: |
  def run(input):
      return { "total": input["quantity"] * input["unitPrice"] }
```

The returned value must be a dict (object) or list; other values are returned as raw strings.

---

## Typed inputs and outputs

Both fields accept either an inline JSON Schema or a named `Type.JsonSchema` reference. The kernel validates inputs before `run` executes and validates the returned value after.

```yaml
kind: Type.JsonSchema
metadata:
  name: PriceInput
schema:
  type: object
  properties:
    quantity: { type: integer }
    unitPrice: { type: number }
  required: [quantity, unitPrice]
---
kind: Starlark.Script
metadata:
  name: ComputePrice
inputType: PriceInput
code: |
  def run(input):
      return { "total": input["quantity"] * input["unitPrice"] }
```

---

## Using it in a sequence

```yaml
kind: Run.Sequence
metadata:
  name: Pricing
steps:
  - name: compute
    invoke:
      kind: Starlark.Script
    inputs:
      quantity: "${{ inputs.quantity }}"
      unitPrice: "${{ inputs.unitPrice }}"
    code: |
      def run(input):
          return { "total": input["quantity"] * input["unitPrice"] }
outputs:
  total: "${{ steps.compute.result.total }}"
```

---

## Notes

- Starlark programs cannot read files, open sockets, or spawn processes. That is the point — use it for pure, deterministic compute you want to accept from less-trusted sources.
- The Node.js controller uses the `starlark-webasm` interpreter. The WASM runtime is initialized once per process; subsequent `Starlark.Script` resources reuse it.
- Output is serialized to JSON on the way back to the kernel. Starlark-specific values (`True`/`False`/`None`) are translated to JSON (`true`/`false`/`null`); ensure your `run` return value only contains JSON-compatible types.
