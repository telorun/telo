---
"@telorun/console": major
---

**Breaking:** `Console.WriteLine` and `Console.ReadLine` are now `Telo.Invocable` and accept their per-call data via `inputs:` instead of as resource-level configuration.

- `Console.WriteLine`'s `output` field moves from the resource `schema` into the kind's `inputType`. Pass it under the step's `inputs:` block.
- `Console.ReadLine`'s `prompt` field moves the same way.
- Both capabilities switch from `Telo.Runnable` to `Telo.Invocable`.

CEL expressions in `output` / `prompt` now resolve naturally against the caller's scope (`steps.*`, `resources.*`, `variables.*`, `secrets.*`) — the previous controller-internal `expandValue(manifest.output, input)` trick is gone.

Migrate call sites from:

```yaml
- name: Greet
  invoke:
    kind: Console.WriteLine
    output: "Hello, ${{ steps.Ask.result.value }}!"
```

to:

```yaml
- name: Greet
  invoke: { kind: Console.WriteLine }
  inputs:
    output: "Hello, ${{ steps.Ask.result.value }}!"
```
