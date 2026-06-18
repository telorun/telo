# Generic dispatch tracing

Make the debug-ui invocation list reflect *everything that executed*, not just
the `invoke()` capability. Today the trace is built from `<Kind>.<Name>.Invoked`
events emitted only by `runInvoke()`. Runnables (Run.Sequence as a boot target),
Providers, and inline live-instance step calls never reach that chokepoint, so
they are missing — and their children, parented to an id that was never minted,
detach into false roots.

## Principle

Trace at the **dispatch chokepoint**, uniformly across capabilities, and carry
all trace data in the event **payload** — never in the event name. A new
capability or resource kind then requires zero UI changes.

## Trace event contract (shipped)

Every capability dispatch emits a symmetric start/end pair. Event names are
domain names with **no kind prefix**:

- end: `<name>.Invoked` / `<name>.Run`; outcome variants stay on the end event
  (`<name>.InvokeRejected[.Undeclared]`, `<name>.InvokeFailed`,
  `<name>.InvokeCancelled`, `<name>.RunFailed`, `<name>.RunCancelled`).
- start: `<name>.Invoking` / `<name>.Running` (distinct present-continuous names,
  not a second `<name>.Invoked`, so subscribers to `<name>.Invoked` still see
  exactly one terminal event per call). Emitted only while tracing is on.

Payload shape (read by the UI; the name is only for event-bus subscriptions):

```ts
{
  spanId: number | undefined,        // present only while tracing
  parentSpanId: number | undefined,
  capability: "invoke" | "run" | "provide",
  phase: "start" | "end",
  outcome: "ok" | "failed" | "rejected" | "cancelled", // end only; absent on start
  ref: { kind: string, name: string },
  // existing per-capability detail stays: inputs/outputs, error code/message, reason
}
```

`spanId` / `parentSpanId` are the `KernelTracer`'s `invocationId` /
`parentInvocationId` (kept under those names on the controller-facing
`InvokeContext`; surfaced as `spanId` only in the wire payload).

## Changes

### 1. Span wrapper — `kernel/nodejs/src/evaluation-context.ts`

- Factor the tracing preamble out of `runInvoke()` (lines ~617-637): a shared
  helper that, under the tracing gate, mints the span id, resolves the parent
  from explicit `ctx` then ambient, builds the child `InvokeContext`, and
  establishes the ALS scope around the call.
- `run()` (line 731) and the provider `provide()` path adopt the same wrapper:
  mint + propagate an id, emit `<name>.Run` / `<name>.Provided` start before the
  call and an end event with `outcome` after. This is the core fix — once
  `run()` mints and propagates an id, Run.Sequence appears and its child steps
  re-attach to it.
- Emit a `phase: "start"` event in all three paths (currently only the end is
  emitted), so the UI can show in-flight spans and order siblings.
- Drop the kind from every emitted event name; move `ref: { kind, name }` into
  the payload along with the structured span fields.

### 2. Remove the live-instance bypass — `sdk/nodejs/src/invoke-step.ts`

- Delete the direct `instance.invoke()` branch (line ~97). Route every step
  dispatch through `ctx.invoke` / `ctx.invokeResolved` so it passes the
  instrumented chokepoint. The extra hop is a `tracer.enabled` branch when
  tracing is off — negligible, and it closes the only path that escapes tracing.

### 2b. Application boot span (shipped)

`ModuleContext.runTargets` wraps the boot `targets` run in an application span
(`<appName>.Run` / `.Running`, `capability: "run"`, `ref.kind: "Telo.Application"`)
and seeds its id as the parent for every target dispatch, so the application is
the trace root with its targets nested beneath. Pre-resolved `!ref` boot targets
go through the new `EvaluationContext.runResolved` (the `run()` analog of
`invokeResolved`) instead of a direct `instance.run()` — closing the last
dispatch bypass. Kind/name for the span come from the `REF_IDENTITY` stamp. Scope:
targets only; services that auto-start during `init()` are not yet covered.

### 2c. Service scope detachment (shipped)

A `Telo.Service`'s `run()` is long-lived, so wrapping it in the cancellation/trace
ALS scope leaked that scope onto every async resource it creates (an HTTP server's
listening socket → every inbound request callback inherited the boot span *and*
cancellation token). `runInstance` now branches on capability: a `Telo.Service`
is called as `instance.run(invokeCtx)` with **no** `cancellationStore.run` wrapping
(its token still arrives via the explicit argument), while Runnables keep the ALS
scope so their steps nest and inherit cancellation. Result: inbound work starts
with a clean ambient — each request is its own root trace, no inherited
cancellation. This is why a `traceRoot` boundary flag was *not* needed: the leak
is fixed at the source.

The capability check resolves the alias kind first (`capabilityOf` → `resolveKind`):
definitions are keyed by their canonical `<module>.<Kind>` (e.g. `http-server.Server`),
but a resource carries the alias it was written with (`Http.Server`), so a raw
`getDefinition("Http.Server")` misses and the service would wrongly be treated as a
Runnable (the original reason requests still nested under boot). Verified with a
real HTTP request in `http-request-trace-detachment.test.ts`.

### 3. Inbound request span + OTel-ready trace ids (shipped)

Generic `ctx.openSpan(base, { ref, label, attributes, inbound? })` on
`ResourceContext` opens an inbound-boundary span (capability `"request"`) that
roots its own trace and returns a child `InvokeContext` to thread into the
handler dispatch (so the handler + subtree nest under it). Tracing-off → no-op
pass-through. `http-server` uses it per request: `ref` = the `Http.Api`,
`label` = `"<METHOD> <path>"`, `attributes` = `{ method, path }`. The route shows
on the node; the Api is the participant; each request is its own trace.

Every span now carries a `traceId` (OTel 16-byte hex), minted at the root
(request span, app boot span, top-level invoke) and inherited via
`InvokeContext.traceId`, so an OTLP exporter maps it directly. `inbound` lets a
request continue an upstream distributed trace (W3C `traceparent`) when that's
wired later. `span_kind` (request→SERVER, else INTERNAL) and ns timestamps remain
exporter-side / additive.

### 3b. Trace context capture — Phase 1 (shipped)

A trace's root span carries `payload.context`: a redacted snapshot of the CEL
root scope (`EvaluationContext.traceRootScope()`, overridden on `ModuleContext`)
— `variables`, `resources` snapshots, `ports`, and `secrets` with values masked
to `"[secret]"` (keys kept so availability is visible). Host `env` is omitted
(raw process environment — too broad to dump). Emitted only on the terminal event
of a root span (where `parentSpanId === undefined`), so it appears once per trace
and the UI's terminal-event fold picks it up. Wire-encoded like any payload; the
UI shows it as an "Available context" section on the root node.

Phase 2 (per-span *local* scope — `steps` / `request` / loop vars threaded from
the expansion sites) remains a follow-up.

**Transport-agnostic tests:** the kernel only tests the generic `openSpan`
primitive (synthetic ref, no transport module — `open-span.test.ts`); the
HTTP-specific wiring (route ref/label/attributes) is tested in the http-server
module (`request-span.test.ts`). The kernel never references a transport kind.

### 4. UI reads the payload — `packages/debug-ui/src/graph.ts` + `packages/debug-wire`

- Replace suffix-string parsing (`deriveInvocations` classifying `.Invoked` /
  `.InvokeFailed` from the event name) with reads off the structured payload:
  `capability`, `phase`, `outcome`, `ref`, `spanId`, `parentSpanId`.
- Use `phase: "start"` to open nodes and `phase: "end"` to close them with an
  outcome; build the tree from `parentSpanId`.
- Update `debug-wire` types if the payload/metadata split changes (move span
  ids from `metadata` into the typed payload).

### 5. Sweep subscribers and tests

- Every `on("<Kind>.<Name>.Invoked")` / pattern match on the old dotted name
  moves to `<name>.*` plus `payload.ref.kind` filtering.
- Update `kernel/nodejs/tests/invocation-tracing.test.ts` and
  `packages/debug-ui/src/graph.test.ts` for the renamed events, the new
  start/end pairs, and `run()`/`provide()` coverage.

## Out of scope

- No change to the tracing gate (still off by default, enabled when a debug
  consumer attaches).
- No new resource-kind-specific events.

## Verification

- Run.Sequence boot target appears as a span with its steps nested beneath it.
- An HTTP request shows a request root with the handler invoke (and any
  downstream invokes/sequences) nested under it.
- An inline live-instance step appears in the trace.
- `pnpm run test` green; debug-ui graph tests cover invoke/run/provide.
