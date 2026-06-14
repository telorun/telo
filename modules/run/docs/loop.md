---
description: "Run.Loop: repeat a step body while a condition holds and/or until a max-iteration cap, with the prior iteration's results in scope."
sidebar_label: Run.Loop
---

# `Run.Loop`

> Examples below assume this module is imported with an `imports:` entry under alias `Run`. Kind references (`Run.Loop`) follow that alias — if you import the module under a different name, substitute your alias accordingly.

`Run.Loop` is a `Telo.Runnable` that repeats its `steps` body while `condition` holds and/or until `maxIterations` is reached. It is the standalone, referenceable loop — the in-sequence inline `while` block still lives in [`Run.Sequence`](../README.md); `Run.Loop` adds iteration scope, a returnable result, and use as a `target`.

The body is the same step grammar as `Run.Sequence` minus the `while` block (the kind is itself the loop).

## Fields

| Field | Description |
| --- | --- |
| `condition` | CEL boolean evaluated before each iteration; the loop continues while it is true. |
| `maxIterations` | CEL integer cap on the number of iterations. |
| `steps` | The body run each iteration. |
| `outputs` | A CEL map evaluated after the loop; its value becomes the result. Omit to return the last iteration's step map. |
| `inputs` | Input contract (JSON Schema property map). |
| `catches` | Whole-operation error contract (`{ when, value }` over `error` and `inputs`). |

**At least one of `condition` or `maxIterations` is required**; the loop stops at whichever trips first.

## Iteration scope

Inside `condition`, `steps`, and `outputs`, two variables are bound in addition to `inputs`:

- `iteration` — the 0-based iteration count (integer).
- `previous` — the prior iteration's step map, or `null` on the first iteration.

`previous` is what enables poll-until-ready: the condition inspects the last iteration's result to decide whether to continue.

```yaml
kind: Run.Loop
metadata:
  name: PollUntilReady
condition: !cel "previous == null || !previous.check.result.ready"
maxIterations: 10
steps:
  - name: check
    invoke: !ref GetStatus
    inputs:
      id: !cel "inputs.jobId"
```

## Result

When invoked (e.g. as a `Run.Sequence` step), a `Run.Loop` returns its `outputs` evaluated over the final state — `steps.*` (the last iteration), `iteration` (final count), `previous`, and `inputs`. With no `outputs`, it returns the last iteration's step map.
