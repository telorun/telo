import type { Invocable } from "./capabilities/invokable.js";
import type { KindRef, ScopeContext } from "./ref.js";
import type { ResourceInstance } from "./resource-instance.js";

/** Retry policy for a single invoke step, passed through to `ctx.invoke`. */
export interface InvokeStepRetry {
  attempts?: number;
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
 *  `InvokeStep` but `name` is optional (only needed for `steps.<name>.result`
 *  plumbing); the boot runner synthesizes one when omitted. */
export interface InlineInvokeTarget {
  name?: string;
  when?: string;
  invoke: KindRef<Invocable> | Invocable;
  inputs?: Record<string, unknown>;
  retry?: InvokeStepRetry;
}

/** A single Application `targets` entry. The kernel boot runner dispatches by
 *  shape: a bare string or resolved `{ kind, name }` runs a Runnable/Service;
 *  `{ ref, when? }` is a guarded run; `{ invoke, ... }` is an inline invoke
 *  step executed via `executeInvokeStep`. */
export type BootTarget =
  | string
  | { kind: string; name: string }
  | { ref: string; when?: string }
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
  let result: unknown;

  if (raw && typeof (raw as Invocable).invoke === "function") {
    result = await (raw as Invocable).invoke(inputs);
  } else {
    const ref = raw as KindRef<Invocable>;
    if (state.scope) {
      const instance = state.scope.getInstance(ref.name) as unknown as ResourceInstance;
      result = await ctx.invokeResolved(ref.kind, ref.name, instance, inputs);
    } else {
      result = await ctx.invoke(ref.kind, ref.name, inputs, { retry: step.retry });
    }
  }

  state.steps[step.name] = { result };
}
