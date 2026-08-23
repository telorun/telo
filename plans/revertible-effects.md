# Revertible effects — `init()` and `run()` return what undoes them

## Problem

A Telo controller creates and destroys in two places that nothing pairs: `init()` builds, `teardown()` undoes. Whether the second actually inverts the first is a convention, and three concrete failures follow from its being one.

**A failed `init()` strands whatever already succeeded.** The multi-pass init loop (`kernel/nodejs/src/evaluation-context.ts`, init sub-phase) records the error and moves on; a resource that never completes stays in `createdInstances`, and `teardownResources()` iterates `resourceInstances`, so it is never in the cascade. The boot fails with an accurate diagnostic on top of a process holding open sockets, registered listeners and half-built pools that nothing will ever reclaim.

**A failed `init()` is retried on the same instance.** The loop re-calls `instance.init(ctx)` on the next pass. An `init()` that registers a listener and then fails to connect registers that listener again on every pass. The retry is legitimate — the loop only continues when some other resource made progress, so the environment genuinely moved — but it is currently a retry from a dirty state.

**Undo is already two mechanisms.** `acquireHold()` returns a release closure the caller must remember to call; `teardown()` is the other. Both are the same shape — an action paired with its undo — implemented separately. (`pendingDetached`/`drainDetached` in `kernel/nodejs/src/resource-context.ts` looks like a third but is not: it waits for in-flight work rather than undoing anything.)

**An opt-in primitive would not have fixed any of it.** The first cut of this work added `ctx.effect` beside `init()`/`teardown()` and left the pair in place. Nothing then asks an author to use it: a controller that allocates directly in `init()` compiles, runs, and looks correct until a boot fails halfway. The reference migration was evidence — `Http.Server` got *longer* and behaved identically, because it has one inverse and `teardown()` already was it. A mechanism whose whole purpose is to stop something being forgotten cannot itself be forgettable.

## Solution

`init()` and `run()` **return** the effects they perform, and `teardown()` is removed.

An effect is a forward action paired with the inverse that undoes it. `ctx.effect(reason, body)` describes one and returns a **chain**; `.effect(...)` extends it, threading the previous step's result into the next body. A controller's `init()` returns that chain instead of performing the work itself:

```ts
init() {
  return this.ctx
    .effect("plugins", async () => ({ result: await this.setupPlugins(), inverse: () => this.app.close() }))
    .effect("routes", async () => ({ result: this.setupRoutes(), inverse: () => {} }));
}
```

The signature is the forcing function, and that is the whole design. `init(): EffectChain` cannot be satisfied by a body that allocates and returns nothing, so "what undoes this" is asked at the one place every author already writes, rather than in an optional third place they have to know exists. There is no `teardown()` left to keep in step with it.

**The chain is LAZY and is not a thenable.** Nothing runs until the kernel executes what init returned, which is what lets the kernel own sequencing, recovery and ordering rather than each controller. Not a thenable because an `async` function unwraps one on the way out: `async init(): Promise<EffectChain>` returning a promise-like would hand the kernel the last step's *result* instead of the chain. Keeping `.effect()` plain means `async init()` still works and an author can `await` freely in the body before returning the chain. Forgetting the `return` is loud and immediate — nothing is allocated, so the resource fails at once — rather than a leak that only shows at teardown.

**Branches and loops build the chain; they do not fight it.** A chain is a value, so a conditional plugin or a mount loop is ordinary code: `let chain = ctx.effect(…); if (cors) chain = chain.effect(…); for (const m of mounts) chain = chain.effect(…); return chain`.

**The accumulator is a stack of frames, one per lifecycle entry.** The kernel opens a frame at `create()` and at each `init()` / `run()`, and a failure unwinds only the frame that failed. Without frames a failed `init()` would run every inverse on the chain, including the ones `create()` registered — unwinding construction and then retrying against a resource whose construction was reverted. Teardown unwinds every open frame, newest first; within a frame, last-in-first-out. Ordering is therefore a consequence of the accumulator rather than a rule to document and get wrong.

**`ctx.effect` is also callable imperatively, and that is the one remaining spelling for per-operation work.** An allocation made inside `invoke()` whose lifetime is an *operation* rather than the resource cannot be a returned chain, because `invoke` returns the caller's value: `Durable.Workflow` takes a hold per run and releases it when the run settles *or parks*. So the awaited form stays, its inverse joins the resource's frame, and the operation disposes it when it ends. Two spellings, split by which question they answer — the chain says *what this resource is made of*, the imperative call says *what this operation is holding*.

**There is no invocation frame.** A scope that ends when a call returns is `try`/`finally`, and a frame closing at return would release the durable hold at exactly the wrong moment. An imperative effect must be disposed by the operation that made it, or it accumulates for the resource's lifetime — the author's obligation, and the weaker one, since the alternative is a bare closure nothing reclaims at teardown either.

**An effect can be disposed early, and out of order.** `dispose()` runs that one inverse now and removes it from its frame — idempotent, and skipped at recovery. **A frame is a recovery order, not a dependency graph**: disposing an effect a later one depends on is the author's error, and cascading disposal to everything registered afterwards would break the case it exists for — `run()` takes its hold before it opens the socket, and releasing the hold must not close the socket.

**A body may be an iterator.** `body` either resolves to `{ result, inverse }` or is an async generator yielding one inverse per completed step (§4.3.2's degenerate-iterator form). The generator is what a single step that allocates N things needs: each `yield` registers that step's inverse the moment it completed, so a body that throws between allocations recovers exactly what it did, and a body interrupted by a shutdown stops at the next step boundary and recovers only what accumulated.

**A failed `init()` recovers, and the instance is discarded.** On a throw the frames unwind, and the kernel then drops the instance and re-runs `create()` on the next pass rather than re-calling `init()` on the same object. Inverses restore *external* state; a controller's own fields — a half-built server, a partially populated route table — are not something an inverse can reach, so re-initializing the same instance would leave exactly the dirty-retry this plan exists to remove, just one level in. This is §4.3.4's `L-Raise`, reconciled with Telo's multi-pass loop: the paper withholds a failed fiber outright because it would be retried against an *unchanged* environment, which is not Telo's case. It is also the half that needs no author cooperation — it fires for every controller, and it is what lets `Http.Server` delete the per-mount resumability bookkeeping that existed only to survive a second `init()` call.

**`acquireHold` folds onto the primitive.** A hold becomes an effect whose inverse is its release — `acquireHold` already returns its own inverse, so it composes as literally itself — reclaimed on unwind whether or not its owner remembered. The teardown-wrapping in `kernel.ts` is deleted.

**Detached draining stays its own teardown-phase concern.** A drain is not an inverse: it *waits* for in-flight work under a bounded timeout and then abandons it with a warning. An inverse either succeeds or refuses, so modelling the drain as one would turn an abandoned background task into a recovery failure and leave the timeout policy nowhere to live. `pendingDetached` / `drainDetached` keep their own shape, invoked by the kernel after a resource's frames have unwound.

The contract is normative in `kernel/specs/revertible-effects.md` — the chain, its laziness, frames, LIFO recovery, the iterator form, the failure rules — because the Rust kernel will implement the same accumulator, and a tracking contract is exactly the kind of thing that diverges silently between runtimes. A lazy chain is a *description*, which is what makes it portable. Rust SDK parity is out of scope: `sdk/rust/` is `Telo.Invocable`-only and has no lifecycle to translate until it grows `Telo.Service`.

**The whole standard library migrates**, because `teardown()` is removed: 17 controllers implement it today (`sql`, `mcp-server`, `scheduler`, `record-stream`, the durable modules, …). That is the real size of the change and it is not stageable — a surface that still accepts `teardown()` is a surface an author can still forget through.

## Decisions

- **`init()` / `run()` return their effects; `teardown()` is removed.** The signature is what stops the mechanism being forgettable. Rejected: `ctx.effect` beside a retained `teardown()` — implemented once, and nothing pointed an author at it; the reference controller grew and behaved identically.
- **A chain, not a list of effects.** Threading each step's result into the next is how an inverse gets the handle it must close, without a `let` per allocation escaping to instance state.
- **Lazy, and not a thenable.** Laziness puts sequencing and recovery in the kernel and makes the chain a description a second runtime can execute. Non-thenable because an `async` function unwraps a promise-like on return, which would hand the kernel a result instead of a chain.
- **Imperative `ctx.effect` stays for operation-scoped work.** `Durable.Workflow`'s per-run hold is made inside `invoke()` and released when the run settles or parks; a returned chain cannot express it. Two spellings, one accumulator.
- **No invocation frame.** A scope that ends when a call returns is `try`/`finally`. An imperative effect joins the resource's frame and is the author's to dispose.
- **Frames, not one flat chain.** A failure must unwind what that lifecycle entry did and nothing older. A flat chain would make a failed `init()` revert `create()`.
- **Effects can be disposed early and out of order.** It is what admits a per-operation allocation whose count is bounded by concurrency only if inverses leave the frame when the operation ends. Rejected: recovery-only effects, which would leave that hold outside the mechanism and still leaking on an abrupt teardown. Rejected: cascading disposal to everything registered after it, which would close the listener the hold was released ahead of.
- **Iterator form from the start.** CLAUDE.md forbids YAGNI on cross-cutting primitives, and this is what the later dependency-driven divert and configuration reconciliation rest on. Two consumers exist immediately regardless.
- **A failed `init()` recovers, then the instance is recreated.** Telo's loop only continues on progress elsewhere, so the environment really did move. Rejected: re-calling `init()` on the same instance, which leaves the controller's own half-built fields in place and makes clean retry a per-controller convention again.
- **The detached drain is not folded in.** It waits with a timeout and abandons; an inverse succeeds or refuses. Two mechanisms remain by design, and the single-primitive claim is about *inverses*, not about every teardown-time concern.
- **A failing inverse during pre-retry recovery withholds the resource.** Retrying from a state that could not be rolled back is worse than not retrying; the resource is recorded failed with a root cause naming both the init error and the refusing inverse, and the loop skips it. Rejected: retrying anyway, which is error swallowing at the exact point the mechanism exists to prevent.
- **A failing inverse at teardown aggregates and continues** into `ERR_EFFECT_RECOVERY_FAILED`, mirroring `ERR_TEARDOWN_FAILED` — one throwing resource must not strand the log sinks that are pinned last to outlive it.
- **No per-effect events.** One debug-wire event per effect would swamp both the wire and the logging path; recovery failures surface through `ctx.log` and the aggregate error.
- **`teardownPriority` is untouched.** It orders resources against each other; this plan orders one resource's own effects. Retiring it belongs to the withdrawal-guard work.
- **No manifest surface change**, so no `requires:` floor. `@telorun/sdk` and the kernel are published packages and take changesets; every migrated module takes a fragment.
- **The whole stdlib migrates in this change.** A staged migration would mean a surface that still accepts `teardown()`, which is the surface an author can forget through — the defect this plan exists to remove.

## After the change

A controller says what it is made of, and each part carries its own undo. `Http.Server` returns two effects from `init()` and two from `run()`; if `listen()` fails because the port is bound, the hold is released, the routes are torn down and the plugins are unregistered before the error is recorded — and the next pass, if the loop makes progress elsewhere, builds a fresh instance and initializes that, rather than re-entering one already holding three-quarters of a server. An author who allocates without an inverse no longer writes code that compiles: there is nowhere to put the allocation except an effect. Nothing in any manifest changes.
