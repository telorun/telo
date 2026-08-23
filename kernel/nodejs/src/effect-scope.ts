import type {
  EffectBody,
  EffectChain,
  EffectOutcome,
  EffectResult,
  Inverse,
  ResourceInstance,
} from "@telorun/sdk";
import { RuntimeError } from "@telorun/sdk";

/**
 * The inverse accumulator behind the effect chain.
 *
 * A stack of FRAMES, one per lifecycle entry. The kernel opens a frame at
 * `create()` and at each `init()` / `run()`; a failure unwinds only the frame
 * that failed, so a failed `init()` cannot revert what `create()` did and then
 * retry against a resource whose construction was rolled back. Teardown unwinds
 * every open frame, newest first; within a frame, last-in-first-out.
 *
 * Normative contract: `kernel/specs/revertible-effects.md`.
 */
export type FrameLabel = "create" | "init" | "run";

interface Registration {
  readonly reason: string;
  readonly inverse: Inverse;
  disposed: boolean;
}

interface Frame {
  readonly label: FrameLabel;
  readonly entries: Registration[];
}

/** One inverse that refused, kept with the reason its author gave the effect. */
export interface RecoveryFailure {
  readonly reason: string;
  readonly error: unknown;
}

/** One link of a chain: what to run, and what the author called it. */
interface Step {
  readonly reason: string;
  readonly body: EffectBody<unknown, unknown>;
}

/** One line for an inverse's refusal, quoted into a recovery aggregate. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAsyncGenerator(value: unknown): value is AsyncGenerator<Inverse, unknown, void> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AsyncGenerator).next === "function" &&
    Symbol.asyncIterator in (value as object)
  );
}

/**
 * A lazy chain of steps against one scope.
 *
 * Immutable and value-like, so `chain.effect(...)` in a branch or a loop builds
 * a new description rather than mutating a shared one. Deliberately NOT a
 * thenable: an `async init()` would unwrap it and hand the kernel its last
 * result instead of the chain.
 */
class Chain<T> implements EffectChain<T> {
  constructor(
    private readonly scope: EffectScope,
    private readonly steps: readonly Step[],
  ) {}

  effect<TNext>(reason: string, body: EffectBody<T, TNext>): EffectChain<TNext> {
    return new Chain<TNext>(this.scope, [
      ...this.steps,
      { reason, body: body as EffectBody<unknown, unknown> },
    ]);
  }

  perform(): Promise<EffectResult<T>> {
    return this.scope.execute(this.steps) as Promise<EffectResult<T>>;
  }

  /** The steps, for the kernel executing a chain a controller returned. */
  plan(): readonly Step[] {
    return this.steps;
  }
}

/** A chain produced by this kernel, as opposed to any other object a controller
 *  might return from `init()`. */
export function isEffectChain(value: unknown): value is Chain<unknown> {
  return value instanceof Chain;
}

export class EffectScope {
  /** Innermost last. `create` is opened with the scope, so there is always a
   *  frame to register onto. */
  private readonly frames: Frame[] = [];

  /** Set while this scope is unwinding. A generator body checks it at each step
   *  boundary and stops rather than allocating into a scope that is going away —
   *  the mid-boot SIGINT case. */
  private unwinding = false;

  /** Terminal: set by {@link unwindAll}. A closed scope has no frames and takes
   *  no new effects. */
  private closed = false;

  constructor(private readonly label: string) {
    this.openFrame("create");
  }

  /** Refuse work against a scope that has already unwound. Raised BEFORE a
   *  forward body runs, so a late effect cannot allocate and then find it has
   *  nowhere to record the inverse. */
  private assertOpen(what: string): void {
    if (!this.closed) return;
    throw new RuntimeError(
      "ERR_EFFECT_SCOPE_CLOSED",
      `${this.label}: '${what}' cannot run — this resource has been torn down. ` +
        `An effect registered now would record an inverse nothing will ever run.`,
    );
  }

  openFrame(label: FrameLabel): void {
    this.frames.push({ label, entries: [] });
  }

  /** Start a chain. Nothing runs until it is executed. */
  chain<T>(reason: string, body: EffectBody<void, T>): EffectChain<T> {
    return new Chain<never>(this, []).effect(reason, body as EffectBody<never, T>);
  }

  /**
   * Register an inverse for work performed elsewhere, without a forward body.
   *
   * The synchronous door onto the same accumulator, for a primitive that
   * already returns its own inverse: `acquireHold` hands back a release
   * closure, and its public signature is synchronous, so it cannot go through a
   * chain.
   */
  register(reason: string, inverse: Inverse): () => Promise<void> {
    this.assertOpen(reason);
    const entry: Registration = { reason, inverse, disposed: false };
    this.current().entries.push(entry);
    return () => this.disposeEntries([entry]);
  }

  /**
   * Run a chain's steps in order against the frame open NOW, threading each
   * step's result into the next.
   *
   * A step that throws leaves every inverse produced so far on the frame — this
   * does not unwind, because whether a partial `init()` is recovered-and-retried
   * or torn down is the caller's decision, not this function's.
   */
  async execute(steps: readonly Step[]): Promise<EffectResult<unknown>> {
    const registered: Registration[] = [];
    const push = (reason: string, inverse: Inverse): void => {
      const entry: Registration = { reason, inverse, disposed: false };
      this.current().entries.push(entry);
      registered.push(entry);
    };

    let value: unknown = undefined;
    for (const step of steps) {
      this.assertOpen(step.reason);
      if (this.unwinding) {
        throw new RuntimeError(
          "ERR_EFFECT_SCOPE_CLOSING",
          `${this.label}: '${step.reason}' not started because the resource is being torn down`,
        );
      }
      const produced = (step.body as (input: unknown) => unknown)(value);
      if (isAsyncGenerator(produced)) {
        const iterator = produced as AsyncGenerator<Inverse, unknown, void>;
        for (;;) {
          if (this.unwinding) {
            // Stop at the step boundary and let the generator run its own
            // `finally`. What already yielded stays on the frame and is
            // recovered by the unwind in progress.
            await iterator.return?.(undefined as never);
            throw new RuntimeError(
              "ERR_EFFECT_SCOPE_CLOSING",
              `${this.label}: '${step.reason}' stopped because the resource is being torn down`,
            );
          }
          const next = await iterator.next();
          if (next.done) {
            value = next.value;
            break;
          }
          push(step.reason, next.value);
        }
      } else {
        const outcome = (await produced) as EffectOutcome<unknown>;
        // No inverse means the step allocated nothing that outlives a failure —
        // a chain is the sequencing structure for lifecycle work as well as the
        // record of what to undo, so a step with nothing to undo registers
        // nothing rather than a no-op that would read as an oversight.
        if (outcome.inverse) push(step.reason, outcome.inverse);
        value = outcome.result;
      }
    }

    return { result: value, dispose: () => this.disposeEntries(registered) };
  }

  /**
   * Unwind the innermost frame and close it, returning what refused.
   *
   * Failures are returned rather than thrown: the caller decides what a refusal
   * means. Pre-retry recovery withholds the resource (retrying from a state that
   * could not be rolled back is worse than not retrying); teardown aggregates
   * and keeps going, so one throwing resource cannot strand the log sinks pinned
   * to outlive it.
   */
  async unwindFrame(): Promise<RecoveryFailure[]> {
    const frame = this.frames.pop();
    if (!frame) return [];
    return this.runInverses(frame.entries);
  }

  /**
   * Unwind every open frame, innermost first, and CLOSE the scope.
   *
   * Terminal, because both callers are: teardown, and the discard of a resource
   * whose `init()` failed (its replacement is built with a fresh context, so a
   * fresh scope). A closed scope refuses new effects rather than accepting them
   * onto a frame nothing will ever unwind — recording an inverse that will never
   * run is the silent leak this whole mechanism exists to remove, and it is
   * exactly the shape a detached task still settling after teardown produces.
   */
  async unwindAll(): Promise<RecoveryFailure[]> {
    const failures: RecoveryFailure[] = [];
    while (this.frames.length > 0) failures.push(...(await this.unwindFrame()));
    this.closed = true;
    return failures;
  }

  private async runInverses(entries: Registration[]): Promise<RecoveryFailure[]> {
    const wasUnwinding = this.unwinding;
    this.unwinding = true;
    const failures: RecoveryFailure[] = [];
    for (const entry of [...entries].reverse()) {
      if (entry.disposed) continue;
      entry.disposed = true;
      try {
        await entry.inverse();
      } catch (error) {
        failures.push({ reason: entry.reason, error });
      }
    }
    this.unwinding = wasUnwinding;
    return failures;
  }

  private async disposeEntries(entries: Registration[]): Promise<void> {
    const failures = await this.runInverses(entries);
    if (failures.length === 0) return;
    // An explicit dispose HAS a caller, unlike an unwind — so it throws rather
    // than being collected into someone else's aggregate. Every refusal travels,
    // matching the init and teardown paths: a dispose covers a chain, so
    // reporting the first and dropping the rest would hide the others exactly
    // where more than one thing failed to roll back.
    throw new RuntimeError(
      "ERR_EFFECT_RECOVERY_FAILED",
      `${this.label}: ${failures.length} inverse(s) refused: ` +
        failures.map((f) => `'${f.reason}' (${errorText(f.error)})`).join(", "),
      failures.map((f) => ({
        severity: "error" as const,
        message: `inverse '${f.reason}' refused: ${errorText(f.error)}`,
      })),
    );
  }

  private current(): Frame {
    this.assertOpen("effect");
    const frame = this.frames[this.frames.length - 1];
    if (!frame) throw new RuntimeError("ERR_EFFECT_NO_FRAME", `${this.label}: no open effect frame`);
    return frame;
  }
}

/**
 * Execute whatever a lifecycle method returned.
 *
 * A controller that allocates nothing returns nothing, so a non-chain return is
 * not an error — but it is also not an inverse, which is why `init()` returning
 * a chain it forgot to hand back fails loudly and immediately: nothing was
 * allocated at all.
 */
export async function executeReturnedChain(returned: unknown, scope?: EffectScope): Promise<void> {
  if (!isEffectChain(returned)) return;
  if (!scope) {
    throw new RuntimeError(
      "ERR_EFFECT_NO_SCOPE",
      "a controller returned an effect chain from a resource with no effect scope",
    );
  }
  await scope.execute(returned.plan());
}

/**
 * What the teardown cascade needs from a resource's context: its inverses, and
 * its detached-task drain.
 *
 * Structural rather than the context class itself, so the accumulator does not
 * pull the whole `ResourceContextImpl` into every consumer — and so the drain
 * stays visibly a *second* thing, since it waits for in-flight work rather than
 * undoing anything.
 */
export interface EffectOwner {
  readonly effects: EffectScope;
  drainDetached(): Promise<void>;
}

/**
 * An instance's effect owner, recorded at the kernel's single
 * instance-production site — the anchor that already carries handle minting and
 * contract binding, so an instance is never observable without one.
 *
 * A WeakMap rather than a field on the resource-instances map: teardown holds
 * the instance and nothing else, and every reader of that map would otherwise
 * have to learn about effects. First bind wins, mirroring handle minting: a
 * `base:` child IS the parent instance returned verbatim, and re-binding would
 * give one object two accumulators.
 */
const owners = new WeakMap<ResourceInstance, EffectOwner>();

export function bindEffectOwner(instance: ResourceInstance, owner: EffectOwner): void {
  if (!owners.has(instance)) owners.set(instance, owner);
}

export function effectOwnerOf(instance: ResourceInstance): EffectOwner | undefined {
  return owners.get(instance);
}
