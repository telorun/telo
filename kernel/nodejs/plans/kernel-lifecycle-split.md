# Plan — Kernel lifecycle split + public invoke

Goal: split `Kernel.start()` into `boot()` / `runTargets()` / `teardown()`, and expose `Kernel.invoke(ref, inputs)` as a public method. Enables embedders that want "boot once, invoke many" — the AWS Lambda managed-runtime adapter ([lambda-function.md](../../../modules/lambda/plans/lambda-function.md)) is the headline consumer, but the same primitives unblock IDE previews, programmatic tests, and any future warm-invoke surface.

The CLI and existing callers stay on `start()`, which becomes a thin convenience over the new methods. No breaks.

## Change

### Split `Kernel.start()`

[`kernel/nodejs/src/kernel.ts:295-348`](../src/kernel.ts#L295-L348) today is monolithic:

```
register controllers → analyzer.prepare → setInitOrder → initializeResources
  → Kernel.Initialized → Kernel.Starting → runTargets → Kernel.Started
  → waitForIdle → [finally] teardownResources → Kernel.Stopped
```

Refactor into three public methods with the same observable order:

- `async boot(): Promise<void>` — controller register, analyzer prepare, init order, `initializeResources`, emits `Kernel.Initialized`. Does **not** run targets. Does **not** wait. Returns when every resource is initialized and the kernel is ready to accept invokes.
- `async runTargets(): Promise<void>` — emits `Kernel.Starting`, calls `rootContext.runTargets()`, emits `Kernel.Started`. Throws if `boot()` hasn't run.
- `async teardown(): Promise<void>` — emits `Kernel.Stopping`, calls `rootContext.teardownResources()`, emits `Kernel.Stopped`. Idempotent on second call (no-op, no double-emit).
- `start()` becomes a thin convenience that preserves today's contract — every failure path still runs teardown:

  ```ts
  async start(): Promise<void> {
    try {
      await this.boot();
      await this.runTargets();
      await this.waitForIdle();
    } finally {
      await this.teardown();
    }
  }
  ```

  Critical: today's [`start()` at kernel.ts:336-348](../src/kernel.ts#L336-L348) wraps `initializeResources` through `waitForIdle` in a single `try` so a throw from any of them still emits `Kernel.Stopping` / `Kernel.Stopped` and calls `teardownResources`. The `try` in the new `start()` widens to cover `boot()` and `runTargets()` for the same reason — narrowing it to just `waitForIdle()` would silently change the failure contract for the CLI ([`commands/run.ts`](../../../cli/nodejs/src/commands/run.ts)) and test runner ([`modules/test/nodejs/src/suite.ts`](../../../modules/test/nodejs/src/suite.ts)), which both rely on init-time failures still running teardown.

Three-way split rather than two is deliberate: embedders that boot without firing the manifest's `targets` (Lambda managed-mode at module-load time) call `boot()` only; embedders that want the full lifecycle but with explicit teardown control (integration tests asserting on `Kernel.Stopped`) call `boot()` + `runTargets()` + `teardown()` directly.

### Rename existing `shutdown()` → `forceIdle()`

The SDK already exposes `Kernel.shutdown(): void` ([`sdk/nodejs/src/types.ts:105`](../../../sdk/nodejs/src/types.ts#L105), implemented at [`kernel.ts:402-407`](../src/kernel.ts#L402-L407)). Despite the name, it does not tear down — it force-resolves any pending `waitForIdle()` promise so callers blocked on graceful exit (e.g. `SIGINT` handlers) can proceed past their `await kernel.waitForIdle()` even when resources still hold the kernel via `acquireHold()`. Adding a sibling `teardown()` next to a `shutdown()` that does something else would land two methods that both sound terminal.

Rename `shutdown()` → `forceIdle()`. It's a single-purpose method called only from SIGINT/SIGTERM handlers; the rename is mechanical and `teardown()` becomes the only thing on the interface that names cleanup.

Touch points for the rename:

- [`kernel/nodejs/src/kernel.ts`](../src/kernel.ts) — method body, no semantic change.
- [`sdk/nodejs/src/types.ts`](../../../sdk/nodejs/src/types.ts) — interface declaration.
- [`cli/nodejs/src/commands/run.ts:142-148`](../../../cli/nodejs/src/commands/run.ts#L142-L148) — the SIGINT/SIGTERM handler is the only call site outside the kernel package.

This is a break to the published SDK; it bundles into the same minor bump as the new methods (matching the project's existing 0.x pattern of minor-with-break, per the [programmatic-bootstrap plan](./programmatic-kernel-bootstrap.md)). No deprecation alias.

### State machine for invalid transitions

The four new methods have explicit transition rules. All throw `RuntimeError` with code `ERR_KERNEL_STATE_INVALID` on a forbidden transition; the error message names what was attempted (e.g. `"Cannot invoke before boot()"`).

| call | from state | behaviour |
|---|---|---|
| `boot()` | un-booted | → booted |
| `boot()` | booted (or later) | throw |
| `runTargets()` | booted, targets not yet run | → targets-complete |
| `runTargets()` | un-booted, or after teardown | throw |
| `invoke(...)` | booted (any sub-state before teardown) | resolves via `rootContext` |
| `invoke(...)` | un-booted, or after teardown | throw |
| `teardown()` | any state | → torn-down (idempotent) |
| `teardown()` | torn-down | no-op; does not re-emit `Kernel.Stopping` / `Kernel.Stopped` |

Asymmetry rationale: `teardown()` is the cleanup safety net called from `finally` blocks — including from `start()`'s own finally. Throwing inside it would mask the original error that triggered the cleanup. Tolerance of partial state matters too: if `boot()` throws partway through `initializeResources`, `teardown()` still walks whichever resources had initialized and calls their `teardown()`. The other methods are forward-driven user workflows where catching state errors early is the right default.

### Public `Kernel.invoke(ref, inputs)`

Today `ResourceContext.invoke(kind, name, inputs)` exists and works ([`resource-context.ts:150`](../src/resource-context.ts#L150)) but no public surface lets an external embedder call it. Add:

```ts
class Kernel {
  async invoke<TInputs, TOutput>(
    ref: string | { kind: string; name: string },
    inputs: TInputs,
  ): Promise<TOutput>;
}
```

`ref` accepts either a parsed `{kind, name}` or the dot-form string `"My.Handler"` for ergonomics — split on the last `.`. Resolves through the root `ModuleContext` (the same path `ResourceContextImpl.invoke` already takes). Throws if `boot()` hasn't completed; throws if the resource isn't a `Telo.Invocable`.

Five-line delegation; no new event emission added here — the underlying invoke path already emits `Invoked` / `InvokeFailed` / `InvokeRejected` via the controller wrapper at [`kernel.ts:580-590`](../src/kernel.ts#L580-L590).

### Touch points

- [`kernel/nodejs/src/kernel.ts`](../src/kernel.ts) — refactor `start()`, add `boot` / `runTargets` / `teardown` / `invoke`, rename `shutdown` → `forceIdle`.
- [`sdk/nodejs/src/types.ts`](../../../sdk/nodejs/src/types.ts) — extend the `Kernel` interface with all five method-shape changes:

  ```ts
  interface Kernel {
    boot(): Promise<void>;
    runTargets(): Promise<void>;
    teardown(): Promise<void>;
    invoke<TInputs, TOutput>(
      ref: string | { kind: string; name: string },
      inputs: TInputs,
    ): Promise<TOutput>;
    forceIdle(): void;           // was: shutdown(): void
    // existing: start(), load(), waitForIdle(), acquireHold(), on(), ...
  }
  ```

  The interface is the normative shape for any future kernel — including non-Node implementations (Rust, Python). Landing the four-method lifecycle (`boot` / `runTargets` / `teardown` + `start` as convenience) on the SDK makes this the protocol; a future Rust kernel can't ship with only `start()`.
- [`cli/nodejs/src/commands/run.ts`](../../../cli/nodejs/src/commands/run.ts) — call-site rename `kernel.shutdown()` → `kernel.forceIdle()` in the SIGINT/SIGTERM handler. Otherwise unchanged.
- [`modules/test/nodejs/src/suite.ts`](../../../modules/test/nodejs/src/suite.ts) — no change.

### Relation to the programmatic-bootstrap plan

The [in-memory bootstrap plan](./programmatic-kernel-bootstrap.md) renames `loadFromConfig` → `load` and makes `sources` required. This plan layers on top — `boot` / `runTargets` / `teardown` / `invoke` are orthogonal to the rename. If the programmatic plan hasn't landed when this one ships, do the changes against the current `loadFromConfig` API and rebase on the rename.

## Why this shape

The lifecycle methods are observable shapes the kernel already runs internally — they're not new behavior, they're new entry points into existing behavior. The split costs ~30 lines of refactor and unlocks every "boot once, invoke many" embedder we have planned. Alternatives (each embedder ships its own copy of `start()` with the parts it wants; or expose a single `bootAndHold()` flag-bag method) either scatter lifecycle logic across modules or grow the API surface without separating the operations cleanly.

`invoke` mirrors how `ResourceContext.invoke` already works inside controllers (e.g. [`http-server-controller.ts:223`](../../../modules/http-server/nodejs/src/http-server-controller.ts#L223)). Same dispatch, same error path, same event emission — just exposed externally.

## Test

`kernel/nodejs/tests/lifecycle.test.ts` (vitest, wired in by the programmatic-bootstrap plan). Asserts:

Happy path:

- `boot()` returns before any `Telo.Service` target's `run()` fires (use a target that throws if reached).
- `invoke()` works after `boot()` and before `runTargets()`.
- `invoke()` still works during `runTargets()` execution and after it completes (but before teardown).
- `teardown()` after a clean boot tears down every initialized resource exactly once.

State-machine errors (each throws `ERR_KERNEL_STATE_INVALID`):

- `boot()` called twice.
- `runTargets()` called before `boot()`.
- `runTargets()` called after `teardown()`.
- `invoke()` called before `boot()`.
- `invoke()` called after `teardown()`.

Teardown tolerance:

- `teardown()` called twice — no-op on the second call, no re-emit of `Kernel.Stopping` / `Kernel.Stopped`.
- `teardown()` called after a `boot()` that threw partway — cleans up whichever resources had initialized; does not throw.

`start()` contract preservation:

- `start()` produces the same event order as today: `Initialized` → `Starting` → `Started` → `Stopping` → `Stopped`.
- A throw inside `initializeResources` (during `boot()`) still results in `Kernel.Stopping` / `Kernel.Stopped` being emitted and `teardownResources` running — verifies the widened `try` in the new `start()`.
- A throw inside a target (during `runTargets()`) still results in teardown — same property.

`forceIdle()` (renamed):

- `forceIdle()` resolves a pending `waitForIdle()` even when holds are still active. No behaviour change vs the old `shutdown()` — just the name.

## Changeset

Single minor bump on both packages (0.x minor signals breaks, matching the project's existing pattern):

- `@telorun/kernel` — additions: `boot` / `runTargets` / `teardown` / `invoke`. Rename: `shutdown` → `forceIdle`. `start()` semantics unchanged (now a convenience method).
- `@telorun/sdk` — `Kernel` interface gains the four additions; `shutdown` renamed to `forceIdle` on the same interface.

Breaking surface is one rename (`Kernel.shutdown` → `Kernel.forceIdle`) — only known external caller is the CLI's SIGINT handler, updated in the same changeset.

## Out of plan

- **Per-invocation `x-telo-scope` from outside the kernel.** Already works via the existing scope plumbing — resources declaring `x-telo-scope: /path` receive a `ScopeHandle` they can `scope.run(...)` over per call ([`evaluation-context.ts:353`](../src/evaluation-context.ts#L353)). The Lambda adapter uses this directly; no new external API needed.
- **Hot-reload while booted.** Different concern; the watch flag in the CLI is its own thread.
- **Concurrent `invoke` semantics.** The existing controller invoke surface already handles concurrent calls; nothing new to add here.
