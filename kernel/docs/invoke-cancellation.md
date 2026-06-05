---
sidebar_label: Invoke Cancellation
description: "Cooperative invocation cancellation via the out-of-band InvokeContext — token/source split, the pre-dispatch gate, deadlines, and how leaves honor it."
---

# Invoke Cancellation

Telo invocations are cancellable. Every `invoke()` receives a second, out-of-band
argument — an **`InvokeContext`** — carrying a read-only **cancellation token**.
The kernel automatically refuses a not-yet-dispatched invoke whose tree was
cancelled, and honoring leaves (AI streaming, `fetch`, …) stop early when they
observe the token.

Cancellation is **cooperative**: the kernel cannot interrupt running JavaScript.
It refuses dispatch and carries the signal; in-flight work stops only at the
points a controller chooses to check.

## The token / source split

Cancellation follows the standard source/token split
(`AbortController`/`AbortSignal`, `CancellationTokenSource`/`CancellationToken`):

- The **token** (`ctx.cancellation`) is read-only and handed to controllers.
- The **source** is writable and held only by the kernel, embedders, and trigger
  modules — never by the controllers that observe the token.

```ts
interface CancellationToken {
  readonly isCancelled: boolean;                 // synchronous poll
  readonly reason: string | undefined;
  readonly signal: AbortSignal;                  // escape hatch for Web APIs
  onCancelled(listener: (reason?: string) => void): () => void;
  throwIfCancelled(): void;                       // throws ERR_INVOKE_CANCELLED
}

interface InvokeContext {
  readonly cancellation: CancellationToken;
}
```

The `InvokeContext` is an extensible object rather than a bare token so future
per-invoke concerns (trace, idempotency) can join without a breaking signature
change.

## Honoring cancellation in a controller

The token always reaches a controller as the explicit second argument. Poll it
between units of work, hang cleanup off `onCancelled`, or hand its `signal` to a
Web API:

```ts
async invoke(inputs: BatchInput, ctx?: InvokeContext): Promise<BatchOutput> {
  const off = ctx?.cancellation.onCancelled((reason) => this.releasePartial(reason));
  try {
    for (const item of inputs.items) {
      ctx?.cancellation.throwIfCancelled();   // → ERR_INVOKE_CANCELLED
      await this.process(item);
    }
    return this.collect();
  } finally {
    off?.();
  }
}
```

Streaming producers capture the signal **at invoke time** so it rides into the
deferred `Stream` consumption and aborts the live connection on cancel:

```ts
const parts = model.stream({ messages, signal: ctx?.cancellation.signal });
return { output: new Stream(parts) };
```

Ignoring the argument is always safe — the kernel passes a never-cancellable
sentinel when no source has been seeded.

## The pre-dispatch gate

Before dispatching, the kernel checks the tree's token. If it is already
cancelled, the invoke is **refused without touching the controller**: the kernel
emits a scoped `<Kind>.<Name>.InvokeCancelled` event (joining the
`Invoked` / `InvokeRejected` / `InvokeFailed` family) and throws
`ERR_INVOKE_CANCELLED`.

```ts
try {
  await kernel.invoke("Db.query", { sql });
} catch (err) {
  // err.code === "ERR_INVOKE_CANCELLED" — the controller was never called
}
```

A whole invocation tree shares one cancellation scope. Nested invokes from a
composing controller inherit it automatically — nothing is threaded by hand:

```ts
const rows = await this.ctx.invoke("Db.query", { sql });   // cancelled if the tree is
const text = await this.ctx.invoke("Ai.text", { prompt: rows });
```

## Deadlines are scheduled cancellation

There is no separate deadline type — a deadline is just a scheduled cancellation:

- `source.cancelAt(epochMs)` — arm cancellation at an absolute instant.
- `source.cancelAfter(ms)` — sugar over `cancelAt(now + ms)`.

Every honoring leaf gets timeout behavior for free.

## Seeding cancellation

**Embedders** pass an external signal or deadline to `Kernel.invoke`:

```ts
await kernel.invoke("Api.handler", inputs, { signal: controller.signal });
await kernel.invoke("Api.handler", inputs, { deadlineAt: someEpochMs });
```

**Trigger modules** mint a source with `ctx.createCancellationSource()` and pass
`source.context` into `invokeResolved`. Built-in triggers wire it up:

- **`http-server`** holds a per-request source, cancels on client disconnect, and
  returns **499** when a request is cancelled before dispatch.
- **`lambda`** arms `cancelAt(deadlineMs)` from the AWS budget.
- **`http-client`** merges the token's signal with its request timeout.
- **`Ai.Text` / `Ai.TextStream` / `Ai.Agent`** forward the signal into the model
  so an abandoned request stops generating instead of burning tokens.

**The boot `targets` run** has its own scope. `Runnable.run(ctx?)` receives the
token, so long-lived targets (servers, loops) can observe cancellation;
not-yet-started targets are refused at the gate (emitting
`<Kind>.<Name>.RunCancelled` — the `run()` counterpart of `InvokeCancelled` —
and throwing `ERR_INVOKE_CANCELLED`). `Kernel.cancel(reason?)` cancels the boot
scope, and the CLI's **SIGINT/SIGTERM** handler calls it — so Ctrl-C
cooperatively stops honoring targets and in-flight invoke trees before the
process unblocks `waitForIdle()` for graceful exit.

## Polyglot (Rust)

The Rust SDK mirrors the contract: `Controller::invoke(&self, input, ctx: &InvokeContext)`
with a poll-only `ctx.cancellation.is_cancelled()`. A Rust controller can observe
cancellation and stop work (returning `ERR_INVOKE_CANCELLED`). Push delivery
(`onCancelled`) and streaming across the napi boundary are not yet available in
Rust.

**Known limitation:** the napi error bridge surfaces a Rust `ControllerError`'s
code in the error *message*, not as a JS `.code` property (napi sets `.code` from
its own status). So an `ERR_INVOKE_CANCELLED` *thrown* from a Rust controller is
not yet reclassified on the Node side — it surfaces as a generic failure (no
`InvokeCancelled` event, no 499). This affects only mid-flight cancellation of a
long-running Rust controller (the pre-dispatch gate, which runs Node-side before
the controller, is unaffected). Carrying Rust controller codes as JS `.code` is a
separate structured-error-bridge improvement that would fix this for every code,
not just cancellation.
