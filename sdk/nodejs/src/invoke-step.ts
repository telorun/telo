import type { Invocable } from "./capabilities/invokable.js";
import {
  type CancellationToken,
  ERR_INVOKE_CANCELLED,
  type InvokeContext,
  isCancellationError,
} from "./cancellation.js";
import { isAmbientContractErrorCode } from "./contract-errors.js";
import { tryParseDurationMs } from "./duration.js";
import { InvokeError } from "./invoke-error.js";
import type { KindRef, ScopeContext } from "./ref.js";
import { getRefIdentity, type ResourceInstance } from "./resource-instance.js";

/**
 * Retry policy for a single invoke step.
 *
 * The field names are `Http.Request`'s, deliberately: two spellings of one
 * concern in one standard library is how an author learns that backoff means
 * something different depending on where it is written. `delay` is the older
 * duration-string spelling, kept because published manifests carry it, and read
 * as `initialDelay` when that is absent.
 *
 * Consumed HERE, in the leaf, rather than passed to `ctx.invoke`. The leaf has
 * four dispatch branches and only one of them went through `ctx.invoke`, so a
 * policy handed downstream was silently ignored for a pre-injected `!ref` — the
 * dominant shape — and no kernel path ever read it. Owning it at the one place
 * every branch passes through is what makes the field mean anything at all.
 */
export interface InvokeStepRetry {
  /** Re-attempts after the first try. 0 (or absent) disables retrying. */
  attempts?: number;
  /** Milliseconds before the first re-attempt. */
  initialDelay?: number;
  /** Multiplier applied to the delay after each re-attempt. */
  factor?: number;
  /** Ceiling on the delay between re-attempts, in milliseconds. */
  maxDelay?: number;
  /** `full` picks each delay uniformly from [0, delay], decorrelating a fleet
   *  that failed together. */
  jitter?: "none" | "full";
  /** DEPRECATED duration string (`"250ms"`, `"1s"`) — read as `initialDelay`. */
  delay?: string;
}

/**
 * The canonical leaf step shared by the kernel's boot `targets` runner and the
 * `Run.Sequence` controller. `invoke` carries a resolved `{ kind, name }` ref
 * (or a pre-resolved instance once Phase 5 injection / inline resolution ran).
 */
export interface InvokeStep {
  name: string;
  when?: string;
  invoke: KindRef<Invocable> | Invocable;
  inputs?: Record<string, unknown>;
  retry?: InvokeStepRetry;
}

/** An inline flat invoke step on an Application's `targets`. Same as an
 *  {@link InvokeStep} but `name` is optional — it is only needed for
 *  `steps.<name>.result` plumbing, and the boot runner synthesizes one when
 *  omitted. Everything else a dispatch site carries applies here, `retry`
 *  included: both are the same kernel-owned shape, and the schema half now says
 *  so too. Control flow (`if`/`while`/`switch`/`try`) is still Run's. */
export interface InlineInvokeTarget {
  name?: string;
  when?: string;
  invoke: KindRef<Invocable> | Invocable;
  inputs?: Record<string, unknown>;
  retry?: InvokeStepRetry;
}

/** A single Application `targets` entry. The kernel boot runner dispatches by
 *  shape: a bare string or resolved `{ kind, name }` runs a Runnable/Service;
 *  `{ ref, when? }` is a guarded run (ref a bare name or a resolved `!ref`);
 *  `{ invoke, ... }` is an inline invoke step executed via `executeInvokeStep`. */
export type BootTarget =
  | string
  | { kind: string; name: string }
  | { ref: string | { kind: string; name: string }; when?: string }
  | InlineInvokeTarget;

/**
 * The context methods the leaf composes. Satisfied structurally by
 * `ResourceContext` (Run.Sequence) and by a kernel-side adapter over the root
 * module context (boot `targets`). The leaf needs nothing else from the kernel.
 */
export interface InvokeStepContext {
  expandValue(value: any, context: Record<string, any>): any;
  invoke<TInputs>(kind: string, name: string, inputs: TInputs, options?: any): Promise<any>;
  invokeResolved<TInputs>(
    kind: string,
    name: string,
    instance: ResourceInstance,
    inputs: TInputs,
  ): Promise<any>;
  /** Resolve a cross-module exported instance (`!ref Alias.name`) to its live instance.
   *  Optional — providers that pre-resolve cross-module refs before reaching the leaf
   *  (e.g. the boot-target runner) may omit it. */
  resolveImportedInstance?(alias: string, name: string): ResourceInstance | undefined;
}

/**
 * Per-run state threaded through the leaf. `steps` is the result accumulator
 * (mutated in place); `cel` carries extra CEL variables (e.g. `error` inside a
 * Run.Sequence catch) and is empty at boot; `scope` is present only inside a
 * Run.Sequence `with:` scope.
 */
export interface InvokeStepState {
  steps: Record<string, unknown>;
  cel?: Record<string, unknown>;
  scope?: ScopeContext;
  /**
   * The invocation this step runs inside, forwarded from the composer's own
   * `invoke(inputs, ctx)`.
   *
   * Needed for the WAIT, not for the dispatch. The kernel refuses a dispatch
   * reached after the tree was cancelled, so every step boundary is already a
   * cancellation point through the ambient context — but a backoff between two
   * attempts is time spent inside this leaf, where the kernel's gate cannot see
   * it and the ambient store is deliberately not on the SDK surface (it is one
   * runtime's mechanism; a second-language leaf has no `AsyncLocalStorage`).
   * Passing it explicitly is what makes the wait interruptible in any runtime.
   *
   * Present at boot too: the boot runner forwards the kernel's boot cancellation,
   * which the CLI's SIGINT handler trips, so Ctrl-C ends a target parked in a
   * backoff. Absent only for a caller that assembled a step in code and had no
   * invocation to forward.
   */
  invokeCtx?: InvokeContext;
}

/**
 * Execute one invoke step: evaluate the `when` guard, expand `inputs`, resolve
 * and invoke the target, then record `steps[step.name] = { result }`. Knows
 * nothing about control flow — `if`/`while`/`switch`/`try` are the caller's
 * concern.
 */
export async function executeInvokeStep(
  step: InvokeStep,
  ctx: InvokeStepContext,
  state: InvokeStepState,
): Promise<void> {
  const cel = { steps: state.steps, ...state.cel };
  if (step.when !== undefined && !ctx.expandValue(step.when, cel)) return;

  const inputs = ctx.expandValue(step.inputs ?? {}, cel) as Record<string, unknown>;
  const raw = step.invoke as unknown;
  const result = await withStepRetry(step, state.invokeCtx, () =>
    dispatch(raw, inputs, ctx, state),
  );

  state.steps[step.name] = { result };
}

/**
 * Re-attempt a step's dispatch while its policy allows.
 *
 * Retries a DOMAIN failure and nothing else. There is no status to classify at
 * this level, so the classification cannot be positive — what there is instead is
 * an explicit author instruction, since a step carries `retry:` only because
 * someone wrote it. So the rule is stated as exclusions, and both of them are
 * decidable without judgement:
 *
 *   - **Cancellation.** The invocation has been asked to stop; re-issuing it
 *     ignores that.
 *   - **A contract violation**, and a **resolution failure** — the target does not
 *     exist, or cannot be invoked. {@link isAmbientContractErrorCode} names the
 *     first set; {@link UNRETRYABLE_CODES} adds the second. Both are the KERNEL's
 *     verdict on the shape of the call rather than on the work, so they are a
 *     property of the manifest and every re-attempt fails identically — a budget
 *     spent on one is dead time between a typo and the diagnostic that names it,
 *     up to `attempts × maxDelay`. Nothing about a misspelled resource name gets
 *     truer after eight seconds of backoff.
 *
 * The WAIT between attempts is cancellable, for the first reason above. Every
 * other point in a sequence already is — the kernel refuses a dispatch reached
 * after the tree was cancelled — so a backoff is the one interval where a
 * cancelled run would otherwise stay parked, for up to `attempts × maxDelay`.
 *
 * The defaults come from the schema (`Run` steps declare `default:` on every
 * field, as `Http.Request.retry` does), so the `??` fallbacks here are the floor
 * for a caller that assembled a policy in code rather than from a manifest — not
 * a second, competing statement of what a default is.
 */
async function withStepRetry<T>(
  step: InvokeStep,
  invokeCtx: InvokeContext | undefined,
  dispatch: () => Promise<T>,
): Promise<T> {
  const policy = step.retry;
  const attempts = policy?.attempts ?? 0;
  if (!policy || attempts <= 0) return dispatch();

  const initial = policy.initialDelay ?? parseDuration(policy.delay) ?? 250;
  const factor = policy.factor ?? 2;
  const maxDelay = policy.maxDelay ?? 32_000;
  const jitter = policy.jitter ?? "full";

  for (let resend = 0; ; resend++) {
    try {
      return await dispatch();
    } catch (err) {
      if (resend >= attempts || !isRetryable(err)) throw err;
      const backoff = Math.min(maxDelay, initial * Math.pow(factor, resend));
      await waitBeforeResend(
        jitter === "full" ? Math.random() * backoff : backoff,
        invokeCtx?.cancellation,
        step,
        err,
      );
    }
  }
}

/** Kernel verdicts on the CALL rather than on the work, beyond the ambient
 *  contract set. A dispatch that cannot resolve its target is a manifest defect;
 *  re-issuing it re-resolves the same name against the same registry. */
const UNRETRYABLE_CODES = new Set(["ERR_RESOURCE_NOT_FOUND", "ERR_RESOURCE_NOT_INVOKABLE"]);

function isRetryable(err: unknown): boolean {
  if (isCancellationError(err)) return false;
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== "string") return true;
  return !isAmbientContractErrorCode(code) && !UNRETRYABLE_CODES.has(code);
}

/**
 * Wait out the backoff, or give up the moment the invocation is cancelled.
 *
 * The failure that CAUSED the wait rides in the cancellation's `data`. Without
 * it, cancelling mid-backoff would report only that the run was cancelled and
 * the attempt's actual error — the thing the author is retrying because of —
 * would be gone, which is exactly the swallowing a retry loop is prone to.
 *
 * `onCancelled` fires synchronously when the token is already cancelled, so an
 * already-cancelled run clears the timer and rejects without waiting a tick.
 */
function waitBeforeResend(
  ms: number,
  token: CancellationToken | undefined,
  step: InvokeStep,
  pending: unknown,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe?.();
      resolve();
    }, ms);
    const unsubscribe = token?.onCancelled((reason) => {
      clearTimeout(timer);
      // Released on BOTH paths. The listener is the one thing this holds, and a
      // subscription outliving the wait it belongs to is a leak per re-attempt.
      unsubscribe?.();
      reject(
        new InvokeError(
          ERR_INVOKE_CANCELLED,
          `Step "${step.name}": cancelled while waiting to re-attempt` +
            `${reason ? ` (${reason})` : ""}.`,
          { step: step.name, pendingFailure: describeFailure(pending) },
        ),
      );
    });
  });
}

function describeFailure(err: unknown): { code?: string; message: string } {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  const message = err instanceof Error ? err.message : String(err);
  return { ...(typeof code === "string" ? { code } : {}), message };
}

/**
 * The deprecated `delay` duration string, in milliseconds.
 *
 * Delegates to the SDK's one duration grammar rather than restating it: a second
 * spelling here would accept strings `telo check`'s `pattern` rejects, and the
 * two would drift. A malformed value THROWS — falling back to the default would
 * swallow a typo into a silently different backoff, and the schema's `pattern`
 * means anything reaching this already failed static analysis.
 */
function parseDuration(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = tryParseDurationMs(value);
  if (ms === null) {
    throw new InvokeError(
      "ERR_INVALID_VALUE",
      `Step retry: invalid 'delay' ${JSON.stringify(value)}; use a number with a unit, e.g. ` +
        `"250ms", "2s", "1.5m", "1h" — or the preferred 'initialDelay', in milliseconds.`,
    );
  }
  return ms;
}

async function dispatch(
  raw: unknown,
  inputs: Record<string, unknown>,
  ctx: InvokeStepContext,
  state: InvokeStepState,
): Promise<unknown> {
  let result: unknown;

  if (raw && typeof (raw as Invocable).invoke === "function") {
    // A pre-injected live instance (a `!ref` resolved at Phase 5). Route it
    // through the traced chokepoint using the identity the kernel stamped at
    // injection, so the call is instrumented exactly like a by-name dispatch.
    // A truly anonymous instance (no stamp) falls back to a direct call.
    const identity = getRefIdentity(raw as object);
    result = identity
      ? await ctx.invokeResolved(identity.kind, identity.name, raw as ResourceInstance, inputs)
      : await (raw as Invocable).invoke(inputs);
  } else {
    const ref = raw as KindRef<Invocable>;
    if (ref.alias && ref.alias !== "Self") {
      // Cross-module exported instance: resolve into the owning import's context and invoke
      // the live instance directly — works whether or not the step runs inside a `with:`
      // scope (a plain `steps` list has no scope, so name lookup in the local context fails).
      const instance = ctx.resolveImportedInstance?.(ref.alias, ref.name);
      if (!instance) {
        throw new Error(
          `Cross-module reference '${ref.alias}.${ref.name}' did not resolve to an exported instance.`,
        );
      }
      result = await ctx.invokeResolved(ref.kind, ref.name, instance, inputs);
    } else if (state.scope) {
      const instance = state.scope.getInstance(ref.name) as unknown as ResourceInstance;
      result = await ctx.invokeResolved(ref.kind, ref.name, instance, inputs);
    } else {
      result = await ctx.invoke(ref.kind, ref.name, inputs);
    }
  }
  return result;
}
