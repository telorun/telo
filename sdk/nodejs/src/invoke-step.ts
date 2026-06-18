import type { Invocable } from "./capabilities/invokable.js";
import type { KindRef, ScopeContext } from "./ref.js";
import { getRefIdentity, type ResourceInstance } from "./resource-instance.js";

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
 *  plumbing; the boot runner synthesizes one when omitted) and `retry` is not
 *  supported — the boot invoke path takes no retry options, so it is omitted
 *  from the surface rather than silently ignored. */
export interface InlineInvokeTarget {
  name?: string;
  when?: string;
  invoke: KindRef<Invocable> | Invocable;
  inputs?: Record<string, unknown>;
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
      result = await ctx.invoke(ref.kind, ref.name, inputs, { retry: step.retry });
    }
  }

  state.steps[step.name] = { result };
}
