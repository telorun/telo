---
"@telorun/kernel": minor
"@telorun/sdk": minor
"@telorun/ide-support": patch
---

`init()` and `run()` now RETURN what undoes them, and `teardown()` is removed.

An effect is a forward action paired with its inverse. `ctx.effect(reason, body)`
returns a lazy chain, `.effect(...)` extends it — threading each step's result
into the next body, which is how an inverse gets the handle it has to close — and
a controller hands the chain back for the kernel to execute:

```ts
init(ctx) {
  return ctx.effect("pool", async () => {
    const pool = await openPool(url);
    return { result: pool, inverse: () => pool.end() };
  });
}
```

The signature is the point. An optional `teardown()` is one an author can forget,
and so was an opt-in `ctx.effect` beside it; returning the chain asks "what undoes
this" at the one place every controller already writes. A subclass extends its
parent's chain (`super.init(ctx).effect(…)`) and unwinds in reverse construction
order automatically.

The chain is lazy — nothing runs until the kernel executes it, so sequencing and
recovery are the kernel's — and deliberately not a thenable, since an `async`
function would unwrap it and hand the kernel a result instead of a chain. Execute
one in place with `.perform()` for an allocation whose lifetime is an *operation*
rather than the resource (a hold taken per durable run inside `invoke()`); it
returns an idempotent, unordered `dispose()`.

Inverses live on frames — one per `create()`, `init()`, `run()` — and unwind
last-in-first-out. A failed `init()` unwinds and the instance is DISCARDED, so the
multi-pass loop's retry constructs a fresh one; a controller no longer needs
resumability bookkeeping to survive a second `init()` call. A deferral
(`ERR_LOCAL_REF_PENDING` / `ERR_CROSS_MODULE_REF_PENDING`) is not a failure and
keeps the instance. An inverse that refuses during recovery withholds the
resource; one that refuses at teardown aggregates into
`ERR_EFFECT_RECOVERY_FAILED` and the cascade continues.

`inverse` is optional: a step that allocated nothing returns its result alone,
since a chain also sequences lifecycle work and a required no-op closure would
read the same as a forgotten undo.

`acquireHold` keeps its signature and now registers nothing — which frame owns a
hold is the caller's fact, so it returns the raw inverse to place in a chain
(`inverse: ctx.acquireHold()`), and a per-operation hold taken inside `invoke()`
is performed and disposed when that operation ends. The detached-task drain is no
longer folded into `instance.teardown` — it waits for in-flight work rather than
undoing anything, so the cascade calls it after the frames unwind.

A module whose controllers return chains must declare `requires: telo: ">=0.82.0"`:
an older kernel calls `init()`, discards the chain, and allocates nothing.

A scope that has fully unwound is closed: an effect registered after teardown is
refused (`ERR_EFFECT_SCOPE_CLOSED`) before its body runs, rather than recording an
inverse nothing will ever execute.

`@telorun/ide-support` carries only the capability hover text for `Telo.Service`,
which described the retired `teardown()`.

Normative contract: `kernel/specs/revertible-effects.md`. No manifest surface
changes.
