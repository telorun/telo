# Invoke cancellation (`InvokeContext`)

## Problem

Telo invocations cannot be cancelled. Once an `invoke()` is in flight there is
no way to stop the downstream work it triggers — an abandoned HTTP request keeps
its AI stream, fetch, and database calls running until they finish on their own.
There is also no way to refuse an invoke that has been reached but not yet
started. We want cooperative cancellation with two guarantees: the kernel
automatically refuses a not-yet-dispatched invoke whose request was cancelled,
and in-flight leaves (AI streaming first) stop early when they honor a
cancellation token. It must work for controllers in any language (Node and Rust
today), must not leak into CEL evaluation, and must add no manifest construct
yet.

## Solution

Give every invocation a second, out-of-band argument — an `InvokeContext` — that
carries a read-only **cancellation token**. The token exposes a poll
(`isCancelled`), a reason, a subscription (`onCancelled`), a throw helper, and a
Node `AbortSignal` escape hatch for handing off to Web APIs. The writable
**cancellation source** behind it (`cancel`, `cancelAt`, `cancelAfter`) is held
only by the kernel, embedders, and trigger modules — never by the controllers
that observe the token. This is the standard source/token split
(`AbortController`/`AbortSignal`, `CancellationTokenSource`/`CancellationToken`).
The contract lives in the SDK (`sdk/nodejs`, `sdk/rust`) as the second parameter
of `invoke`; both shapes match, with Rust omitting the `AbortSignal` (its native
token is the thing) and getting poll-only in the first pass.

A deadline is not a separate concept: `source.cancelAt(epochMs)` arms the token
to trip at an instant, so any code holding a deadline simply schedules a
cancellation and every honoring leaf gets timeout behavior for free. `cancelAt`
(absolute) is the primitive; `cancelAfter(ms)` is sugar over it.

The kernel owns the lifecycle. In `kernel/nodejs/src/evaluation-context.ts`, the
single dispatch path (`invoke` → `invokeResolved` → `runInvoke`) opens a fresh
cancellation scope on the first invoke of a tree and inherits the enclosing
token on nested invokes, so an entire invocation tree shares one scope.
Immediately before dispatch, `runInvoke` checks the token: if already cancelled
it emits a `<Kind>.<Name>.InvokeCancelled` event (joining the existing
`Invoked` / `InvokeRejected` / `InvokeFailed` family) and throws
`ERR_INVOKE_CANCELLED`, never touching the controller.

**The token always reaches the controller as the explicit `InvokeContext`
argument — never via ambient state.** The kernel-internal `AsyncLocalStorage`
exists only so the kernel's own `invoke` / `invokeResolved` can discover *which*
token the current tree owns when a composing controller calls
`this.ctx.invoke(...)` without re-threading it by hand. On every dispatch the
kernel reads the ambient token from the store (or, if the store is empty, opens
a fresh scope), then passes that token **explicitly** as the second argument to
the dispatched controller. Controllers never read `AsyncLocalStorage`; it is
pure kernel bookkeeping. This is why propagation survives the deferred
stream-consumption boundary (where the ALS frame is long gone): the producer
already captured the token from its explicit argument at invoke time. When the
store is empty — a genuine root invoke, or a nested invoke whose ALS frame was
lost across a queue/timer/worker hop — the kernel falls to the shared
never-cancellable sentinel, so the invoke runs uncancellable rather than
inheriting a cancellation it can no longer see. (A lost frame and a real root
both present as an empty store, so the kernel cannot reliably tell them apart;
the supported composition patterns — synchronous `this.ctx.invoke(...)` and
signal capture for deferred streams — never lose the frame.)

`kernel.ts` lets embedders seed the source with an external signal or a deadline
instant via `invoke(ref, inputs, opts?)`; `module-context.ts`,
`resource-context.ts`, and the `sdk/nodejs/src/invoke-step.ts` leaf forward the
ambient token so `Run.Sequence` steps and boot `targets` inherit it for free.

Honoring leaves opt in. `ai-openai` and `ai` pass the token's signal into the
Vercel AI SDK (`streamText` / `generateText`) and capture it into the returned
`Stream` so deferred consumption can abort the live LLM connection;
`http-client` merges the token's signal with its existing timeout controller.
The first trigger source is HTTP client disconnect: `http-server` holds a
per-request source, calls `cancel("client-disconnect")` on socket close, and
returns 499 when a request is cancelled before dispatch. `lambda` arms its
source with `cancelAt(deadlineMs)` from the AWS budget it already reads.

Rollout is phased: (1) kernel + Node SDK contract and gating; (2) AI streaming
leaves honor the signal — the driving use case; (3) `http-client` signal merge,
`http-server` disconnect trigger, lambda deadline; (4) Rust SDK trait + macro +
starlark migration.

**Crossing the napi line (phase 4).** The napi bridge marshals invoke `inputs`
as a `serde_json::Value` snapshot, so the token cannot ride the input — a
serialized token would freeze at dispatch and read its boot value forever.
Instead the same JS `InvokeContext` object the kernel already passes as the
second argument is forwarded across the bridge: the `#[controller]` macro takes
an extra `Option<JsObject>` parameter, and `is_cancelled()` reads
`ctx.cancellation.isCancelled` (a getter) from that object on each poll. This is
a per-poll callback into JS, valid for the synchronous duration of the
controller's `invoke()` — controllers poll between coarse units of work, not in
tight loops, so the crossing cost is negligible. Push delivery (`onCancelled`
across a threadsafe function) and streaming across napi remain genuinely
deferred; the polyglot guarantee is poll-only — stated plainly rather than
implied for free.

## Decisions

- **`AbortSignal` as the primitive, single "cancel" vocabulary** — it is the
  platform standard, already used by `lambda` and `http-client`, and composes
  directly with `fetch` and `streamText`. Every verb and event we own says
  "cancel" (`cancel`, `cancelAt`, `cancelAfter`, `isCancelled`, `onCancelled`,
  `InvokeCancelled`, `ERR_INVOKE_CANCELLED`); the lone "abort" is the typed
  `signal: AbortSignal` field, kept because it is the literal type Web APIs
  consume. Rejected: a custom token (needs adapting at every I/O boundary) and
  `abortAfter`-style setters (split the cancellation vocabulary).
- **Source/token split, deadlines as scheduled cancellation** — a writable
  source (`cancel(reason)` / `cancelAt(epochMs)` / `cancelAfter(ms)`) held by the
  kernel, embedders, and trigger modules; a read-only token handed to
  controllers. There is no `Deadline` type — a deadline is just
  `cancelAt(epochMs)`, so the same token covers timeouts. `cancelAt` is
  absolute because lambda's deadline is already an absolute instant and absolute
  deadlines propagate without clock drift; `cancelAfter` is sugar. Rejected: a
  `deadline` value object on the token — no first-pass consumer reads it, and a
  Go-style `remainingMs()` budget reader is a non-breaking additive for later.
- **Second argument is an extensible object, not a bare token** — changing the
  `invoke` signature later is a breaking change across both SDKs, the
  `#[controller]` macro, and every controller. The wrapper is cheap insurance.
  Rejected: passing the token directly, which corners us into a breaking type
  change or a third positional the moment a second per-invoke concern appears.
- **Cancellation nested under `ctx.cancellation`, not flattened onto the
  context** — keeps the token a single composable value to forward, combine with
  `AbortSignal.any`, or clone into a Rust task; avoids member collisions as the
  context grows (trace, idempotency); matches grab-bag-context prior art (.NET
  `HttpContext.RequestAborted`, gRPC). Rejected: flat members, which only fit if
  the context were cancellation-only forever.
- **Out-of-band from CEL** — the context is a distinct positional argument and is
  never merged into the `expandWith` / `{ self, inputs }` evaluation scope built
  in `resource-template-controller.ts`, so CEL and the analyzer stay blind to it.
  This is the reason it is an argument rather than part of `inputs`.
- **`AsyncLocalStorage` is kernel-internal bookkeeping, never the contract** —
  the token reaches controllers **only** as the explicit `InvokeContext`
  argument. ALS exists solely so the kernel's own `invoke`/`invokeResolved` can
  look up the current tree's token when a composing controller re-invokes
  without re-threading it; the kernel reads it from the store and passes it
  explicitly on dispatch. Because the controller-facing value is always the
  argument, it crosses the napi line to Rust and survives the deferred
  stream-consumption boundary (where the ALS frame is already gone). When the
  store is empty (a real root, or a nested invoke whose frame was lost across a
  queue/timer/worker hop) the kernel falls to the shared never-cancellable
  sentinel — the two cases are indistinguishable from an empty store, and the
  supported composition patterns never lose the frame. Rejected: ALS as the
  controller-facing mechanism, which is Node-only and breaks both polyglot and
  streaming.
- **Open one scope per tree, inherit on nested** — every invocation tree shares
  one cancellation scope without threading a parameter through intermediate
  controllers.
- **No per-invoke source on the common path** — the dispatch path never creates
  a source. Invokes that seed no cancellation — the vast majority, including hot
  `Run.Sequence` steps and per-request handlers — carry a shared, never-cancellable
  sentinel token (one process-wide `AbortController` backs its signal), so there
  is no per-invoke allocation. A real `CancellationSource` is created only by a
  trigger / embedder that actually wants to cancel (`createCancellationSource()`,
  or `Kernel.invoke`'s `signal`/`deadlineAt`), and is disposed once the invoke
  settles to release any deadline timer. Cost: one `AsyncLocalStorage.run` only
  when the token differs from the ambient one (a root or a freshly-seeded scope);
  inherited nested invokes skip the `run` and pay an O(1) `getStore()` read.
  Rejected: a per-tree `AbortController`, which adds allocation pressure to every
  invocation for a feature most never use.
- **Cancellation is a distinct structured error plus an event, never swallowed**
  — `ERR_INVOKE_CANCELLED` and `InvokeCancelled` make a cancelled invoke
  observable rather than a silent no-op. Mid-flight cancellation stays
  cooperative: the kernel cannot interrupt running JS, only refuse dispatch and
  carry the signal.
- **No declarative surface yet** — cancellation is a purely runtime concern; the
  ambient token is the substrate for a future `cancelWhen` or
  deadline-from-manifest without reworking the contract.
- **Rust gets poll first, via a per-poll JS callback** — the token cannot ride
  the serialized `serde_json::Value` input (a marshalled snapshot would freeze
  at dispatch). The atomic-via-napi-`External` design was rejected as infeasible:
  the kernel ships no native module to mint an `External`, and an `External`'s
  type identity is per-`.node`, so it can't be a generic kernel handle. Instead
  the same JS `InvokeContext` object the kernel already passes as the second
  argument is forwarded across the bridge (`#[controller]` adds an
  `Option<JsObject>` parameter); `is_cancelled()` reads `ctx.cancellation.isCancelled`
  from it on each poll — a per-poll callback into JS, valid for the synchronous
  duration of `invoke()`. The token is **not** `Clone`, so a controller can't
  retain it past the call (where the JS handle dies). Push/await delivery
  (`onCancelled` over a threadsafe function) and streaming across napi are
  deferred. Known gap: a Rust-*thrown* `ERR_INVOKE_CANCELLED` is not yet
  reclassified Node-side — the napi error bridge carries a controller's code in
  the message, not as JS `.code` (napi sets `.code` from its status). The
  pre-dispatch gate (Node-side) is unaffected; only mid-flight cancel of a
  long-running Rust controller is. Fixing it (Rust codes → JS `.code`) is a
  separate structured-error-bridge change covering every code, not just cancel.

## Example behavior

An `Ai.TextStream` invoked through an `Http.Server` route: the client
disconnects mid-response. `http-server` calls `cancel("client-disconnect")` on
that request's source. Any sub-invoke the handler had not yet started is refused
at the gate with `ERR_INVOKE_CANCELLED`; the in-flight LLM stream aborts because
`ai-openai` passed the token's signal into `streamText`, so generation stops
instead of burning tokens for a caller who is gone. The same machinery covers a
`Run.Sequence` whose later step is skipped once the tree is cancelled, and a
lambda invocation whose source was armed with `cancelAt(deadlineMs)` and trips
automatically as the AWS deadline approaches.

## Usage examples

Illustrative only — these show how each site reads or arms cancellation, not
full implementations. The second argument is the `InvokeContext`; the read-only
token is `ctx.cancellation`; the writable handle is a cancellation source
obtained from `ctx.createCancellationSource()` (a new `ResourceContext` method)
or seeded by the kernel.

### Honoring leaf — AI streaming (the driving case)

The producer captures the signal at invoke-time so it rides into the `Stream`'s
deferred consumption and aborts the live LLM connection on cancel.

```ts
// modules/ai/nodejs/src/ai-text-stream-controller.ts
async invoke(inputs: AiTextStreamInputs = {}, ctx?: InvokeContext): Promise<AiTextStreamOutput> {
  const signal = ctx?.cancellation.signal;
  const parts = model.stream({ messages, options: mergedOptions, signal });
  return { output: new Stream(parts) };
}

// modules/ai-openai/nodejs/src/openai-model-controller.ts
async *stream({ messages, options, signal }: ModelInvokeInput): AsyncIterable<StreamPart> {
  const result = streamText({ /* … */, abortSignal: signal });
  for await (const delta of result.textStream) {
    if (delta) yield { type: "text-delta", delta };
  }
}
```

### Honoring leaf — http-client fetch

Caller cancellation and the existing timeout both abort the request.

```ts
// modules/http-client/nodejs/src/http-request-controller.ts
const timeout = AbortSignal.timeout(timeoutMs);
const signal = ctx?.cancellation.signal
  ? AbortSignal.any([timeout, ctx.cancellation.signal])
  : timeout;
const response = await fetch(url, { method, headers, body, signal });
```

### Generic Invocable — cooperative checkpoints

A non-streaming invoke that does chunked work bails between units; cleanup
hangs off `onCancelled`.

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

### Pre-dispatch gate (automatic)

No controller code — a sub-invoke reached after the tree was cancelled never
runs; the kernel throws before dispatch and emits `InvokeCancelled`.

```ts
try {
  await kernel.invoke("Db.query", { sql });
} catch (err) {
  // err.code === "ERR_INVOKE_CANCELLED" — invoke was refused, the controller was never called
}
```

### Nested inheritance

A composing controller's sub-invokes inherit the tree's token automatically via
the captured `ResourceContext` — nothing is threaded by hand.

```ts
async invoke(inputs: Input, ctx?: InvokeContext): Promise<Output> {
  const rows = await this.ctx.invoke("Db.query", { sql });   // cancelled if the tree is cancelled
  const enriched = await this.ctx.invoke("Ai.text", { prompt: rows });
  return { enriched };
}
```

### Trigger — HTTP client disconnect → 499

```ts
// modules/http-server/nodejs/src/http-api-controller.ts
const source = this.ctx.createCancellationSource();
request.raw.on("close", () => {
  if (!reply.sent) source.cancel("client-disconnect");
});
try {
  const result = await this.ctx.invokeResolved(kind, name, instance, inputs, source.context);
  reply.send(result);
} catch (err) {
  if (err.code === "ERR_INVOKE_CANCELLED") return reply.code(499).send();
  throw err;
}
```

### Trigger — deadline (lambda) and `cancelAfter` sugar

```ts
// modules/lambda/nodejs/src/function.ts
const source = this.ctx.createCancellationSource();
source.cancelAt(invocation.context.deadlineMs);          // absolute AWS budget
await this.ctx.invokeResolved(kind, handlerName, handler, event, source.context);

// sugar elsewhere — a self-imposed budget:
source.cancelAfter(30_000);                               // === cancelAt(now + 30s)
```

### Trigger — programmatic embedder

```ts
const controller = new AbortController();
const result = await kernel.invoke("Api.handler", inputs, { signal: controller.signal });
// …or seed a deadline directly:
await kernel.invoke("Api.handler", inputs, { deadlineAt: someEpochMs });
```

### Rust controller — poll (first pass)

```rust
// modules/<name>/rust/src/lib.rs
fn invoke(&self, input: Value, ctx: &InvokeContext) -> Result<Value> {
    for item in self.batch(&input)? {
        if ctx.cancellation.is_cancelled() {
            return Err(ControllerError::new("ERR_INVOKE_CANCELLED", "cancelled"));
        }
        self.process(item)?;
    }
    Ok(Value::Null)
}
```
