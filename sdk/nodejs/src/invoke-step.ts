import type { Invocable } from "./capabilities/invokable.js";
import {
  type CancellationToken,
  ERR_INVOKE_CANCELLED,
  type InvokeContext,
  UNCANCELLABLE_CONTEXT,
  createCancellationSource,
  deriveContext,
  isCancellationError,
} from "./cancellation.js";
import { isAmbientContractErrorCode } from "./contract-errors.js";
import {
  durableHandleOf,
  journalingSuppressed,
  stepPath,
  type DurableRunHandle,
  type DurableTarget,
} from "./durable-run.js";
import {
  SUSPENDING_BACKOFF_MS,
  assertMaySuspend,
  isSuspension,
  parkRun,
} from "./durable-suspension.js";
import type { OpenZoneAttributes } from "./zone-attribute.js";
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
  /**
   * Error codes that end the loop immediately instead of consuming the budget.
   *
   * The leaf's built-in exclusions are the ones decidable WITHOUT judgement —
   * cancellation, and the kernel's verdicts on the shape of the call. Whether a
   * DOMAIN failure is worth re-attempting is not decidable here at all: an
   * `ERR_PAYMENT_DECLINED` and an `ERR_UPSTREAM_TIMEOUT` are the same shape to
   * this loop, and only the author knows that re-presenting a declined card
   * changes nothing. Without this, every terminal domain failure is retried to
   * exhaustion — which is not merely wasted time but, for a non-idempotent
   * target, N extra attempts at a side effect.
   *
   * Named by CODE rather than by a predicate because a code is what crosses
   * every boundary this has to survive: a manifest declares it, `catches:`
   * already matches on it, and a relocating backend ships it as data. Both
   * hosted engines express the same knob — Temporal's non-retryable error types,
   * Restate's terminal-versus-retryable split — so a policy written here means
   * the same thing wherever the step ends up executing.
   */
  nonRetryable?: string[];
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
  /**
   * How long ONE attempt may take, in milliseconds. On elapse the dispatch is
   * cancelled and the step fails `ERR_STEP_TIMEOUT`.
   *
   * Per attempt rather than for the whole loop, matching Temporal's
   * start-to-close: a budget spanning the retries would make the last attempt's
   * allowance depend on how slow the earlier ones were, so an author could not
   * state what any single call is allowed to take. A whole-operation bound is a
   * different thing and belongs to whatever owns the operation.
   *
   * It bounds the step rather than the target because the target does not know
   * who is waiting: the same `Http.Request` is a 30-second batch call from one
   * step and a 500ms call on a request path from another. It is also what a
   * backend that chooses WHERE a step executes needs in order to choose —
   * Temporal runs a short step as a local activity and a long one as an
   * activity, which is not a decision a manifest should have to make.
   *
   * Enforced by cancellation, never by abandoning the call: the timeout source
   * is linked to the caller's token and threaded into the dispatch, so a target
   * that honours cancellation stops working rather than continuing unobserved
   * past a deadline nobody is waiting on any more.
   */
  timeout?: number;
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
  /** Open zones with what each declares about its contents — how the leaf and
   *  the engine read the collapse rule. Optional so the structural context stays
   *  satisfiable by a host with no zone machinery; ABSENT MEANS "no zone is
   *  open", which is the direction that journals MORE rather than less, and so
   *  the safe one. */
  zoneAttributes?(ctx?: InvokeContext): readonly OpenZoneAttributes[];
  invokeResolved<TInputs>(
    kind: string,
    name: string,
    instance: ResourceInstance,
    inputs: TInputs,
    /** Seeds the dispatch's invocation context, replacing the ambient — how a
     *  step `timeout:` reaches the target it bounds. Optional so a leaf caller
     *  that never sets one is unchanged. */
    ctx?: InvokeContext,
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
  /**
   * This step's journal key, when the composer tracks one — see
   * {@link stepPath}. Absent for a caller that assembled a step in code, and for
   * the boot runner, whose targets are not a durable body.
   *
   * Supplied by the composer rather than derived here because a path is a
   * property of the enclosing STRUCTURE (which branch, which loop turn, which
   * fan-out element), and the leaf sees one step.
   */
  journalPath?: string;
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

  const rawHandle = durableHandleOf(state.invokeCtx);
  // Inside a collapsed region the engine records NOTHING of its own: the region
  // re-runs whole on resume, so per-step entries would describe work that is
  // about to happen again. A resource inside it may still journal directly —
  // which is what lets `Durable.Value` pin an impure evaluation there rather
  // than be a prescription with nowhere to write.
  const handle =
    rawHandle && journalingSuppressed(ctx, state.invokeCtx, rawHandle) ? undefined : rawHandle;
  const path = state.journalPath ?? step.name;

  // The RESOLVED inputs are journaled, not re-derived. They are read from a CEL
  // scope carrying live readings — `resources.<name>.status` is republished on
  // every dispatch by design — so a fresh process can compute different
  // arguments for the same step and hand them to a target the journal will then
  // answer for, with no mismatch to detect.
  const inputs = (handle
    ? await handle.decide(stepPath(path, "inputs"), "inputs", () =>
        ctx.expandValue(step.inputs ?? {}, cel),
      )
    : ctx.expandValue(step.inputs ?? {}, cel)) as Record<string, unknown>;

  const raw = step.invoke as unknown;
  // The dispatch carries THIS step's path, so anything it reaches that runs a
  // step body of its own hangs those paths under this one rather than starting
  // over at the root. Set only inside a durable run: outside one there is no
  // path to carry, and deriving a context would be a rebuild for nothing.
  // Derived from the RAW handle, not the collapse-suppressed one: collapse
  // suppresses the engine's own per-step entries, never the journal. A
  // `Durable.Value` or a parking kind inside a collapsed region still records
  // directly, and it keys off this path — so dropping it here would give every
  // such resource in the region ONE key inherited from an enclosing level.
  const stepCtx =
    rawHandle && state.invokeCtx
      ? deriveContext(state.invokeCtx, { durablePath: path })
      : state.invokeCtx;
  const execute = () =>
    withStepRetry(step, stepCtx, ctx, rawHandle, path, (attemptCtx) =>
      withStepTimeout(step, attemptCtx, (dispatchCtx) =>
        dispatch(raw, inputs, ctx, { ...state, invokeCtx: dispatchCtx }),
      ),
    );

  // Retry and the timeout sit INSIDE the handed-over effect, not around it: a
  // re-attempt is part of performing this step once, so a backend that ships the
  // step elsewhere ships its policy with it rather than re-attempting a remote
  // dispatch it does not own. This is also what keeps the attempt loop's own
  // rule intact — the journal records the OUTCOME of the step, and a step whose
  // third attempt succeeded completed once.
  const result = handle
    ? await handle.step(path, targetIdentityOf(raw), inputs, execute)
    : await execute();

  state.steps[step.name] = { result };
}

/**
 * The target's DECLARATION-SITE identity, for a backend that may execute the
 * step somewhere the instance does not exist.
 *
 * Derived from the `!ref` identity the kernel stamps at Phase-5 injection, which
 * is the only declaration-site fact a resolved target carries — instance
 * identity is process-local by construction. Undefined when the step dispatches
 * something with no stamp (a truly anonymous instance), which a local backend
 * handles by simply running `execute` and a relocating one must refuse rather
 * than guess.
 */
function targetIdentityOf(raw: unknown): DurableTarget | undefined {
  if (raw && typeof raw === "object") {
    const stamped = getRefIdentity(raw as object);
    if (stamped) return { kind: stamped.kind, name: stamped.name };
    const ref = raw as Partial<KindRef>;
    if (typeof ref.kind === "string" && typeof ref.name === "string") {
      return { kind: ref.kind, name: ref.name };
    }
  }
  return undefined;
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
  ctx: InvokeStepContext,
  handle: DurableRunHandle | undefined,
  path: string,
  dispatch: (ctx: InvokeContext | undefined) => Promise<T>,
): Promise<T> {
  const policy = step.retry;
  const attempts = policy?.attempts ?? 0;
  if (!policy || attempts <= 0) return dispatch(invokeCtx);

  const jitter = policy.jitter ?? "full";

  for (let resend = 0; ; resend++) {
    try {
      return await dispatch(invokeCtx);
    } catch (err) {
      if (resend >= attempts || !isRetryable(err, policy.nonRetryable)) throw err;
      // The UN-JITTERED backoff, which is a pure function of the declared policy
      // and the attempt index — and which is therefore what the park decision
      // below turns on. Deciding on the jittered value instead would put
      // `Math.random()` on a control-flow branch inside a determinism contract:
      // the same attempt could sleep on one pass and park on the next, for no
      // reason a reader of the manifest could see. It would also make the static
      // check unstateable, since the analyzer cannot know which way a coin
      // landed. Jitter still does its whole job — spreading re-attempts — on the
      // duration itself, in both branches.
      const backoff = retryBackoffMs(policy, resend);
      const delay = jitter === "full" ? Math.random() * backoff : backoff;

      // A LONG backoff inside a durable run suspends rather than sleeps, and the
      // attempt state is journaled with it. The obvious reading — only the
      // outcome matters, so journal once — is wrong the moment a backoff
      // suspends: a run that parks mid-retry and resumes in another process must
      // know which attempt it was on, or it restarts the policy from zero and a
      // three-attempt cap becomes unbounded.
      //
      // ONE DECISION PER ATTEMPT, holding when that attempt was due, is the
      // whole mechanism. It needs nothing beyond `decide`: on resume the loop
      // re-runs from attempt zero, each recorded attempt hands back a due time
      // already in the past and is therefore consumed without waiting, and the
      // first UNRECORDED attempt computes a fresh one and parks. The budget is
      // preserved because the replayed attempts still count against it.
      if (handle && backoff >= SUSPENDING_BACKOFF_MS) {
        const attemptPath = stepPath(path, "retry", resend);
        const dueAt = (await handle.decide(attemptPath, "value", () => Date.now() + delay)) as number;
        if (Date.now() < dueAt) {
          // Refused inside a region that promised nothing in it suspends. The
          // check is here rather than at the policy, because a short backoff
          // never suspends and rejecting one would forbid a retry that is
          // perfectly safe in a lease.
          assertMaySuspend(ctx, invokeCtx, { resource: step.name ?? path });
          await parkRun(handle, { path: attemptPath, resource: step.name ?? path }, { at: dueAt });
        }
        continue;
      }

      await waitBeforeResend(delay, invokeCtx?.cancellation, step, err);
    }
  }
}

/**
 * The backoff before attempt `resend + 1`, before jitter.
 *
 * ONE formula, exported because the analyzer needs the same number: it decides
 * statically whether a step's declared policy would park inside a region that
 * cannot be held open, and a second copy of exponential-backoff arithmetic in
 * the analyzer would be a rule that drifts from the behaviour it describes the
 * first time either side gains a knob.
 *
 * Jitter is deliberately NOT applied here. It belongs to the duration, not to
 * the shape of the policy, and the two consumers want the shape: the runtime
 * branches on it (see `withStepRetry`) and the analyzer reports on it.
 *
 * The `??` fallbacks are the floor for a caller that assembled a policy in code;
 * a manifest gets its defaults from the schema.
 */
export function retryBackoffMs(policy: InvokeStepRetry, resend: number): number {
  const initial = policy.initialDelay ?? parseDuration(policy.delay) ?? 250;
  const factor = policy.factor ?? 2;
  const maxDelay = policy.maxDelay ?? 32_000;
  return Math.min(maxDelay, initial * Math.pow(factor, resend));
}

/** Kernel verdicts on the CALL rather than on the work, beyond the ambient
 *  contract set. A dispatch that cannot resolve its target is a manifest defect;
 *  re-issuing it re-resolves the same name against the same registry. */
const UNRETRYABLE_CODES = new Set(["ERR_RESOURCE_NOT_FOUND", "ERR_RESOURCE_NOT_INVOKABLE"]);

function isRetryable(err: unknown, nonRetryable?: string[]): boolean {
  if (isCancellationError(err)) return false;
  // A suspension is not a failure — it is the run leaving. Re-attempting it
  // would park again under the same policy until the budget ran out, and the
  // last attempt would propagate a park the earlier ones had already recorded.
  if (isSuspension(err)) return false;
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== "string") return true;
  // The author's own exclusions, checked beside the built-in ones rather than
  // before or after them: they are the same question — is re-issuing this call
  // capable of a different answer — asked about a domain failure the leaf has no
  // way to classify. A step timeout is never in this set by default; whether a
  // slow call is worth re-attempting is exactly the judgement an author makes.
  if (nonRetryable?.includes(code)) return false;
  return !isAmbientContractErrorCode(code) && !UNRETRYABLE_CODES.has(code);
}

/**
 * Bound ONE attempt, by cancellation rather than by abandonment.
 *
 * A `Promise.race` that simply rejects would leave the call running, holding its
 * connection and eventually completing a side effect nobody is waiting on — the
 * failure mode a timeout is usually adopted to prevent. So a timeout mints a
 * cancellation source, LINKS it to the caller's token (or the caller's
 * cancellation would stop propagating the moment a step declared a bound), and
 * threads its context into the dispatch. A target that honours cancellation
 * stops; one that does not is no worse off than before.
 *
 * The elapse is reported as `ERR_STEP_TIMEOUT` rather than as a cancellation,
 * because the two want opposite follow-ups: a cancelled run was asked to stop,
 * while a timed-out step is a target that is too slow for this call site — and
 * `catches:` can only tell them apart if they carry different codes.
 */
async function withStepTimeout<T>(
  step: InvokeStep,
  invokeCtx: InvokeContext | undefined,
  dispatch: (ctx: InvokeContext | undefined) => Promise<T>,
): Promise<T> {
  const ms = step.timeout;
  if (ms === undefined || !(ms > 0)) return dispatch(invokeCtx);

  const source = createCancellationSource();
  const base = invokeCtx ?? UNCANCELLABLE_CONTEXT;
  // Everything else on the context — zones, tracing, and whatever a later
  // member adds — rides across unchanged. Rebuilding it as a literal here is
  // the drop `deriveContext` exists to prevent.
  const scoped = deriveContext(base, { cancellation: source.token });
  const unlink = invokeCtx?.cancellation.onCancelled((reason) => source.cancel(reason));

  let elapsed = false;
  source.cancelAfter(ms);
  const timedOut = source.token.onCancelled(() => {
    if (!invokeCtx?.cancellation.isCancelled) elapsed = true;
  });

  try {
    return await dispatch(scoped);
  } catch (err) {
    if (elapsed && isCancellationError(err)) {
      throw new InvokeError(
        "ERR_STEP_TIMEOUT",
        `Step '${step.name}' exceeded its timeout of ${ms}ms and was cancelled`,
        { step: step.name, timeout: ms },
      );
    }
    throw err;
  } finally {
    timedOut();
    unlink?.();
    // Releases the pending deadline timer, so a step that finished early does
    // not pin a timer alive until its bound elapses.
    source.dispose();
  }
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

  // The context this attempt runs under: the step's timeout scope when it
  // declares one, else whatever the composer forwarded. Threaded explicitly
  // rather than installed as ambient because the SDK leaf has no ambient store
  // to install into — that is one runtime's mechanism, and a second-language
  // leaf has no `AsyncLocalStorage`.
  const attemptCtx = state.invokeCtx;

  if (raw && typeof (raw as Invocable).invoke === "function") {
    // A pre-injected live instance (a `!ref` resolved at Phase 5). Route it
    // through the traced chokepoint using the identity the kernel stamped at
    // injection, so the call is instrumented exactly like a by-name dispatch.
    // A truly anonymous instance (no stamp) falls back to a direct call.
    const identity = getRefIdentity(raw as object);
    result = identity
      ? await ctx.invokeResolved(
          identity.kind,
          identity.name,
          raw as ResourceInstance,
          inputs,
          attemptCtx,
        )
      : await (raw as Invocable).invoke(inputs, attemptCtx);
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
      result = await ctx.invokeResolved(ref.kind, ref.name, instance, inputs, attemptCtx);
    } else if (state.scope) {
      const instance = state.scope.getInstance(ref.name) as unknown as ResourceInstance;
      result = await ctx.invokeResolved(ref.kind, ref.name, instance, inputs, attemptCtx);
    } else {
      result = await ctx.invoke(ref.kind, ref.name, inputs, { ctx: attemptCtx });
    }
  }
  return result;
}
