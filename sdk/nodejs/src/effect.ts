/**
 * Revertible effects — the module-author half of the lifecycle.
 *
 * An effect is a forward action paired with the inverse that undoes it.
 * `init()` and `run()` RETURN the effects they perform, as a chain built with
 * `ctx.effect(...)`, and the runtime executes it, keeps the inverses per
 * lifecycle entry, and unwinds them last-in-first-out. There is no `teardown()`:
 * the signature is what stops "what undoes this" from being forgotten, which an
 * optional second method never did.
 *
 * Normative contract: `kernel/specs/revertible-effects.md`.
 */

/**
 * An action's undo. Runs when its frame unwinds, or early via
 * {@link EffectHandle.dispose}.
 *
 * Returns `unknown` rather than `void`: the runtime awaits whatever it gets and
 * ignores it, and a great many disposal calls return something incidental
 * (`client.quit()` → `"OK"`). Requiring `void` would have every author wrap a
 * one-line inverse in a block for no gain.
 */
export type Inverse = () => unknown;

/**
 * What a forward action produces: its value, and what undoes it.
 *
 * `inverse` is OPTIONAL, and omitting it is a statement rather than a shortcut:
 * this step allocated nothing that outlives a failure. A chain is also the
 * sequencing structure for lifecycle work — a step that must run after the one
 * before it — so a step with genuinely nothing to undo is a normal shape, and
 * forcing `() => {}` would make "nothing to undo" indistinguishable from "the
 * author forgot the undo", which is the one thing this mechanism exists to tell
 * apart.
 */
export interface EffectOutcome<T> {
  result: T;
  inverse?: Inverse;
}

/**
 * The forward action, given the previous step's result.
 *
 * Either form is accepted, and the single-outcome case is the degenerate
 * iterator. Reach for the generator when one step allocates several things that
 * can fail between them: each `yield` registers that allocation's inverse the
 * moment it completed, so a body that throws halfway — or is stopped by a
 * teardown at a step boundary — recovers exactly what it did.
 */
export type EffectBody<TIn, TOut> =
  | ((input: TIn) => Promise<EffectOutcome<TOut>>)
  | ((input: TIn) => AsyncGenerator<Inverse, TOut, void>);

/**
 * A lazy, ordered description of the effects a lifecycle entry performs.
 *
 * **Lazy**: nothing runs until the runtime executes what `init()` / `run()`
 * returned, so sequencing and recovery belong to the runtime rather than to each
 * controller — and the chain stays a description, which is what a second runtime
 * can execute rather than reimplement.
 *
 * **Deliberately not a thenable**: an `async` function unwraps a promise-like on
 * the way out, so a thenable chain returned from `async init()` would reach the
 * runtime as its last step's *result*. Keeping it plain means `async init()`
 * works and a controller may `await` freely before returning the chain.
 *
 * A chain is a value, so branches and loops build it like any other:
 *
 * ```ts
 * let chain = ctx.effect("core", …);
 * if (resource.cors) chain = chain.effect("cors", …);
 * for (const mount of mounts) chain = chain.effect(`mount ${mount.path}`, …);
 * return chain;
 * ```
 */
export interface EffectChain<T> {
  /** Extend the chain. `body` receives the previous step's result — which is how
   *  an inverse gets the handle it has to close, without a field on the instance
   *  existing only to carry it between the two halves. */
  effect<TNext>(reason: string, body: EffectBody<T, TNext>): EffectChain<TNext>;
  /**
   * Execute the chain NOW against the resource's current frame, instead of
   * returning it for the runtime to execute.
   *
   * The imperative door, and the one spelling for an allocation whose lifetime
   * is an *operation* rather than the resource: `Durable.Workflow` takes a hold
   * inside `invoke()` and releases it when the run settles or parks, which no
   * returned chain can express because `invoke` returns the caller's value.
   * Explicit rather than implicit (a thenable) — laziness is the property the
   * returned form rests on, and a chain that ran when awaited would make "did
   * this execute?" depend on whether someone happened to await it.
   */
  perform(): Promise<EffectResult<T>>;
}

export interface EffectHandle {
  /**
   * Run this effect's inverse now and take it off its frame — for an allocation
   * whose lifetime is an *operation* rather than the resource (a hold taken per
   * durable run, released when the run settles or parks).
   *
   * Idempotent, and a disposed effect is skipped when the frame unwinds. Order
   * is unconstrained: a frame is a recovery order, not a dependency graph, so
   * disposing something a later effect still depends on is the author's error —
   * the runtime cannot see inside an inverse, and cascading would defeat the
   * case early disposal exists for.
   */
  dispose(): Promise<void>;
}

/** What an imperative `ctx.effect(...)` awaits to: the value, plus the way to
 *  end that one allocation early. */
export interface EffectResult<T> extends EffectHandle {
  readonly result: T;
}
