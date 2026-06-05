---
"@telorun/sdk": minor
"@telorun/kernel": minor
"@telorun/cli": minor
"@telorun/ai": minor
"@telorun/ai-openai": minor
"@telorun/http-client": minor
"@telorun/http-server": minor
"@telorun/lambda": minor
---

Add cooperative invoke cancellation via an out-of-band `InvokeContext`.

Every `invoke(inputs, ctx?)` now receives a second argument carrying a read-only
cancellation token (`ctx.cancellation`): poll `isCancelled`, subscribe via
`onCancelled`, bail with `throwIfCancelled`, or hand its `signal` to a Web API.
The SDK exposes the source/token split (`createCancellationSource`,
`CancellationSource`/`CancellationToken`), a never-cancellable sentinel, and the
`isCancellationError` helper. Deadlines are scheduled cancellation
(`source.cancelAt(epochMs)` / `cancelAfter(ms)`).

The kernel mints one cancellation scope per invocation tree (inherited by nested
invokes via a kernel-internal `AsyncLocalStorage`, always passed to controllers
as the explicit argument), refuses a not-yet-dispatched invoke whose tree was
cancelled with `ERR_INVOKE_CANCELLED`, and emits a scoped `InvokeCancelled`
event. `Kernel.invoke(ref, inputs, opts?)` accepts `{ signal, deadlineAt }`.
Sources are allocated lazily, so invokes that never touch cancellation pay no
extra allocation.

The boot `targets` run is also cancellable: `Runnable.run(ctx?)` now receives
the token, `Kernel.cancel(reason?)` cancels the boot scope, and the CLI's
SIGINT/SIGTERM handler calls it so Ctrl-C cooperatively stops honoring targets
and in-flight invoke trees (then unblocks graceful exit via `forceIdle`).

Honoring leaves: `Ai.Text` / `Ai.TextStream` / `Ai.Agent` forward the token's
signal into the model (aborting a live LLM stream on cancel); `http-client`
merges it with its request timeout. Triggers: `http-server` cancels on client
disconnect and returns 499; `lambda` arms cancellation at the AWS deadline.
