---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/sdk": minor
"@telorun/ide-support": minor
---

A `with:` scope's resources read the inputs of the call that opened the scope. A kind declares it with `x-telo-scope: { regions: [...], openedBy: dispatch }` (`Telo.Sequence` does); the members' creation-time fields then read `inputs`, typed by the holder's `inputType` under `telo check` (an undeclared field is `CEL_UNKNOWN_FIELD`, refused at load too) and offered by the editor's completion, while a scope in the string or list form binds nothing (`CEL_UNKNOWN_IDENTIFIER`). `openedBy: dispatch` on a kind nothing dispatches, or a malformed object form, is `SCOPE_OPENED_BY_INVALID` / `ERR_SCOPE_OPENED_BY_INVALID`.

`ScopeHandle.run` now takes the opening inputs as its first, required argument — an object on a scope opened by dispatch, `null` on any other; a legacy one-argument open reads as `null`, and a disagreement is `ERR_SCOPE_OPENING_INVALID`. Every run registers its own copy of the member declarations, so a run after the first no longer reuses the first run's injected instances.

A run is its contract applied to `{}`: the kernel fills an instance's input-contract defaults, validates them (`ERR_INPUT_INVALID`) and hands them to `run(ctx, inputs)` (`Controller.Run` gains `inputs`), so a sequence started as a boot target reads its defaults; `CONTRACT_INPUTS_AT_RUN_SITE` now refuses any contract `{}` fails.

Each scope run owns a redaction set — the opening inputs at the holder's `x-telo-sensitive` paths, matched by substring — applied to the logs, `Created` properties and trace payloads of the resources created in the run, to the trace payloads of the dispatches the holder issues inside it (`InvokeContext.scopeRun`, the step engine's per-dispatch identity from `ScopeContext.runIdentity`) and of the opening dispatch, and to an error that left the run. The module context's set never grows with call count.

A scope run lives until the streams leaving it settle. What `ScopeHandle.run`'s callback returns is handed back with every stream in it held, and the run is torn down once each has been read to its end, failed or been cancelled — in the background, a teardown failure logged on the holder as `scope.teardown.failed`; a run nothing leaves is torn down before `run` returns, as before. `Telo.Sequence` produces its `outputs` inside the scope, so a scoped resource's stream it returns, maps or hands to detached work keeps the resource alive. Every dispatch now carries its own `InvokeContext.owner` (inherited by `deriveContext`, `owner` on the controller protocol's dispatch contexts, additive within `telo-10`), which owns a held stream returned to it and cancels one it never reads when it ends; a source from `ctx.createCancellationSource()` is a root owner until it is disposed or cancelled, the boot runner one owner for its whole `targets:` run, and a context with no owner — `ctx.rootContext()` alone, the free `createCancellationSource()` — owns nothing, so a held stream reaching it is cancelled at once and a later pull raises `ERR_INVOKE_CANCELLED` naming the fix. A `Telo.Service`'s `run()` now runs with no ambient invocation context.
