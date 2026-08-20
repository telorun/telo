# Revertible effects — `ctx.effect` as the kernel's only mutation primitive

## Problem

A Telo controller creates and destroys in two places that nothing pairs: `init()` builds, `teardown()` undoes. Whether the second actually inverts the first is a convention, and three concrete failures follow from its being one.

**A failed `init()` strands whatever already succeeded.** The multi-pass init loop (`kernel/nodejs/src/evaluation-context.ts`, init sub-phase) records the error and moves on; a resource that never completes stays in `createdInstances`, and `teardownResources()` iterates `resourceInstances`, so it is never in the cascade. The boot fails with an accurate diagnostic on top of a process holding open sockets, registered listeners and half-built pools that nothing will ever reclaim.

**A failed `init()` is retried on the same instance.** The loop re-calls `instance.init(ctx)` on the next pass. An `init()` that registers a listener and then fails to connect registers that listener again on every pass. The retry is legitimate — the loop only continues when some other resource made progress, so the environment genuinely moved — but it is currently a retry from a dirty state.

<<<<<<< Updated upstream
**Disposal is already three mechanisms.** `pendingDetached`/`drainDetached` (`kernel/nodejs/src/resource-context.ts`) is a per-resource inverse register, folded into `instance.teardown` by hand at the instance-production site in `kernel/nodejs/src/kernel.ts`. `acquireHold()` returns a release closure the caller must remember to call. `teardown()` is the third. Each is the same shape — an action paired with its undo — implemented separately.
=======
**Undo is already two mechanisms.** `acquireHold()` returns a release closure the caller must remember to call; `teardown()` is the other. Both are the same shape — an action paired with its undo — implemented separately. (`pendingDetached`/`drainDetached` in `kernel/nodejs/src/resource-context.ts` looks like a third but is not: it waits for in-flight work rather than undoing anything.)
>>>>>>> Stashed changes

## Solution

Adopt the revertible-effect model from `kernel/specs/spatiotemporal-composability.md` §3.1 and §5.1.1: an effect is a forward action that yields its own inverse, and the runtime accumulates inverses and applies them last-in-first-out. The primitive is `ctx.effect` on `ResourceContext`; the accumulator lives on the kernel's `ResourceContextImpl` beside where `pendingDetached` lives today, and is folded in at `kernel.ts`'s single instance-production site — the same anchor that already carries handle minting and contract binding, and for the same reason: an instance is never observable without one.

**The kernel's lifecycle vocabulary reduces to effects.** The kernel no longer calls `init()` and `teardown()` as a pair; it runs one effect per resource and recovers it. The SDK's capability adapters translate: a controller's `init()` is the forward action and its `teardown()` the inverse it returns. Existing controllers are unchanged, and the two surfaces coexist permanently — `teardown()` remains the right shape for a coarse, single-allocation resource, while `ctx.effect` is what a controller reaches for when `init()` performs several allocations that can fail between them.

**Ordering falls out of LIFO and needs no rule.** Effects a controller registers during `init()` land on the accumulator before the adapter's outer inverse does, so recovery runs `teardown()` first and the fine-grained inverses after. That is nested rather than flat — recovering the init effect recovers everything init did underneath it (§3.3.1's hierarchical composition) — and it happens to preserve the order controllers already expect.

<<<<<<< Updated upstream
**Tracking begins when the `ResourceContext` is constructed**, so an effect performed in `create()` is on the chain alongside `init()`, `run()` and `invoke()`. Template controllers and `Telo.Import` do real work in `create()`; excluding it would leave the largest allocations of the boot untracked.

**The primitive takes the iterator form.** `fn` may return a single inverse or be an async generator yielding one per step, with the single-inverse case as the degenerate iterator (§4.3.2). Two consumers exist on day one: the self-disposal guard, which stops a long `init()` at the next iteration boundary when the resource is torn down mid-boot (SIGINT during boot) and recovers only what accumulated; and the failed-init recovery below. `L-Divert` proper — aborting because a dependency's availability turned — belongs to the reconciliation work that follows.

**A failed `init()` recovers before the next pass.** On a throw the accumulated inverses run immediately, so the retry starts from the pre-init state and becomes sound rather than doubling effects. This is §4.3.4's `L-Raise`, reconciled with Telo's multi-pass loop: the paper withholds a failed fiber outright because it would be retried against an *unchanged* environment, which is not Telo's case.

**`acquireHold` and `runDetached` fold onto the primitive.** A hold becomes an effect whose inverse is its release; detached-task draining becomes an effect registered at context construction. `pendingDetached`, `drainDetached` and the teardown-wrapping in `kernel.ts` are deleted. Without this the kernel would still carry three disposal mechanisms and the single-primitive claim would be decorative.
=======
**Tracking begins when the `ResourceContext` is constructed**, so an effect performed in `create()` is on the chain alongside `init()` and `run()`. Template controllers and `Telo.Import` do real work in `create()`; excluding it would leave the largest allocations of the boot untracked. **`invoke()` is outside the mechanism** — a per-request allocation would push an inverse per call that nothing discharges until teardown, which is unbounded growth on the dispatch path; per-invocation cleanup stays the controller's own `try`/`finally`.

**The accumulator is a stack of frames, one per lifecycle entry.** The kernel opens a frame at `create()` and at each `init()` / `run()`, and a failure unwinds only the frame that failed. Without frames a failed `init()` would run every inverse on the chain, including the ones `create()` registered — unwinding construction and then retrying against a resource whose construction was reverted. Teardown unwinds every open frame, newest first; within a frame, LIFO.

**An effect can be discharged early.** `ctx.effect` returns a handle whose `discharge()` runs that one inverse now and removes it from its frame, so LIFO is the recovery order rather than an invariant on when an inverse may run. This is what a hold needs: a hold is released at a moment the controller chooses — a one-shot releases it so `waitForIdle` can return — and an inverse that could only run during recovery would invert the dependency, since teardown is the thing the hold is blocking.

**The primitive takes the iterator form.** `fn` may return a single inverse or be an async generator yielding one per step, with the single-inverse case as the degenerate iterator (§4.3.2). Two consumers exist on day one: the self-disposal guard, which stops a long `init()` at the next iteration boundary when the resource is torn down mid-boot (SIGINT during boot) and recovers only what accumulated; and the failed-init recovery below. `L-Divert` proper — aborting because a dependency's availability turned — belongs to the reconciliation work that follows.

**A failed `init()` recovers, and the instance is discarded.** On a throw the failed frame's inverses run immediately, and the kernel then drops the instance and re-runs `create()` on the next pass rather than re-calling `init()` on the same object. Inverses restore *external* state; a controller's own fields — a half-built server, a partially populated route table — are not something an inverse can reach, so re-initializing the same instance would leave exactly the dirty-retry this plan exists to remove, just one level in. Recreating makes "retry from a clean state" literal instead of a convention each controller has to honour. This is §4.3.4's `L-Raise`, reconciled with Telo's multi-pass loop: the paper withholds a failed fiber outright because it would be retried against an *unchanged* environment, which is not Telo's case.

**`acquireHold` folds onto the primitive.** A hold becomes an effect whose inverse is its release, discharged early through the effect handle wherever the controller releases it today. The teardown-wrapping in `kernel.ts` is deleted.

**Detached draining stays its own teardown-phase concern.** A drain is not an inverse: it *waits* for in-flight work under a bounded timeout and then abandons it with a warning. An inverse either succeeds or refuses, so modelling the drain as one would turn an abandoned background task into a recovery failure and leave the timeout policy nowhere to live. `pendingDetached` / `drainDetached` keep their own shape, invoked by the kernel after a resource's frames have unwound.
>>>>>>> Stashed changes

The contract is normative in a new `kernel/specs/revertible-effects.md` — tracking, LIFO recovery, the iterator form, the failure rules — because the Rust kernel will eventually implement the same accumulator, and a tracking contract is exactly the kind of thing that diverges silently between runtimes. Rust SDK parity is out of scope: `sdk/rust/` is `Telo.Invocable`-only and has no lifecycle to translate until it grows `Telo.Service`.

`modules/http-server` migrates to `ctx.effect` as the reference consumer — it registers plugins and routes, listens, and acquires a kernel hold, which is the multi-allocation shape the primitive exists for. Every other module stays on the adapter; migrating them is opportunistic, not a stopgap.

## Decisions

- **The kernel deals only in effects; the SDK translates `init`/`teardown`.** One recovery mechanism in the runtime, with the familiar pair kept as an authoring convenience. Rejected: keeping both in the kernel, which is what makes "single primitive" untrue.
- **LIFO, with no explicit rule about where `teardown()` sits.** It is registered as the outer effect's inverse, so ordering is a consequence of the accumulator rather than a policy to document and get wrong.
- **Tracking starts at `ResourceContext` construction, not at `init()`.** `create()` is where template controllers and imports allocate; starting later would exclude the boot's largest effects.
<<<<<<< Updated upstream
- **Iterator form from the start.** CLAUDE.md forbids YAGNI on cross-cutting primitives, and this one is what the later dependency-driven divert and configuration reconciliation rest on. Two consumers exist immediately regardless.
- **A failed `init()` recovers, then retries.** Telo's loop only continues on progress elsewhere, so the environment really did move — the paper's blanket withholding would refuse a retry that is genuinely warranted.
=======
- **`invoke()` is excluded.** Its effects are per-request and would accumulate for the resource's whole lifetime; a `finally` is the right shape for a scope that ends when the call does.
- **Frames, not one flat chain.** A failure must unwind what that lifecycle entry did and nothing older. A flat chain would make a failed `init()` revert `create()`.
- **Effects can be discharged early.** LIFO is the recovery order, not a restriction on when an inverse may run — otherwise a hold could not be released before teardown, which is what teardown is waiting on.
- **Iterator form from the start.** CLAUDE.md forbids YAGNI on cross-cutting primitives, and this one is what the later dependency-driven divert and configuration reconciliation rest on. Two consumers exist immediately regardless.
- **A failed `init()` recovers, then the instance is recreated.** Telo's loop only continues on progress elsewhere, so the environment really did move — the paper's blanket withholding would refuse a retry that is genuinely warranted. Rejected: re-calling `init()` on the same instance, which leaves the controller's own half-built fields in place and makes clean retry a per-controller convention again.
- **The detached drain is not folded in.** It waits with a timeout and abandons; an inverse succeeds or refuses. Two mechanisms remain by design, and the single-primitive claim is about *inverses*, not about every teardown-time concern.
>>>>>>> Stashed changes
- **A failing inverse during pre-retry recovery withholds the resource.** Retrying from a state that could not be rolled back is worse than not retrying; the resource is recorded failed with a root cause naming both the init error and the refusing inverse, and the loop skips it. Rejected: retrying anyway, which is error swallowing at the exact point the mechanism exists to prevent.
- **A failing inverse at teardown aggregates and continues** into `ERR_EFFECT_RECOVERY_FAILED`, mirroring `ERR_TEARDOWN_FAILED` — one throwing resource must not strand the log sinks that are pinned last to outlive it.
- **No per-effect events.** One debug-wire event per `ctx.effect` would swamp both the wire and the logging path; recovery failures surface through `ctx.log` and the aggregate error.
- **`teardownPriority` is untouched.** It orders resources against each other; this plan orders one resource's own effects. Retiring it belongs to the withdrawal-guard work.
- **No manifest surface change**, so no `requires:` floor. `@telorun/sdk` and the kernel are published packages and take changesets.
- **Only `http-server` migrates now.** It is the reference multi-allocation controller; a wholesale stdlib migration would bury the mechanism under fifty unrelated diffs.

## After the change

<<<<<<< Updated upstream
A controller that allocates several things in one `init()` writes each beside its own undo, and the runtime guarantees the rest. `Http.Server` registers its plugins, mounts its routes, acquires its kernel hold and starts listening as four tracked effects. If `listen()` fails because the port is bound, the hold is released, the routes are unmounted and the plugins are unregistered before the error is recorded — and the next pass, if the loop makes progress elsewhere, re-runs `init()` against a clean instance rather than one already holding three-quarters of a server. Nothing in any manifest changes.
=======
A controller that allocates several things in one `init()` writes each beside its own undo, and the runtime guarantees the rest. `Http.Server` registers its plugins, mounts its routes, acquires its kernel hold and starts listening as four tracked effects. If `listen()` fails because the port is bound, the hold is released, the routes are unmounted and the plugins are unregistered before the error is recorded — and the next pass, if the loop makes progress elsewhere, builds a fresh instance and initializes that, rather than re-entering one already holding three-quarters of a server. Nothing in any manifest changes.
>>>>>>> Stashed changes
