/**
 * The step grammar and its execution: `invoke` / `value` / `if` / `while` /
 * `switch` / `try` / `throw`, the `steps.<name>.result` accumulator, and the
 * nested-scope walk that resolves an inline `invoke:` into a named resource.
 *
 * WHY THE SDK OWNS THIS. The leaf ({@link executeInvokeStep}) has always lived
 * here; everything above it lived in `modules/run` for no reason anyone chose,
 * and that is what made a step body something only `run`'s own kinds could have.
 * `@telorun/sdk` is the single name in the bundle loader's `REALM_COLLAPSE_NAMES`
 * — symlinked onto the KERNEL's own copy rather than inlined — so it is one
 * version per process whatever anyone pins, and it is reachable from a controller
 * bundle and from the kernel's own boot runner alike. A module library
 * (`exports.code:`) is no longer copied per consumer, but it is still one scope
 * per pinned version, it is outside the seam entirely for an npm-delivered
 * controller, and the kernel cannot reach one at all. For a component whose
 * contract is determinism across a durable run, one implementation is the whole
 * premise.
 *
 * The context is STRUCTURAL ({@link StepEngineContext}), the property the leaf
 * already proved: `ResourceContext` satisfies it, and so does a kernel-side
 * adapter. Nothing here imports the kernel or `run`.
 */

import type { Invocable } from "./capabilities/invokable.js";
import type { InvokeContext } from "./cancellation.js";
import { InvokeError, isInvokeError } from "./invoke-error.js";
import { executeInvokeStep, type InvokeStep, type InvokeStepContext } from "./invoke-step.js";
import type { KindRef, ScopeContext } from "./ref.js";

/**
 * What the engine needs beyond the leaf's own contract: turning an inline
 * `invoke: { kind, … }` into a named reference.
 *
 * Widened from {@link InvokeStepContext} rather than replaced, so one interface
 * describes a step site whether or not control flow is involved. Satisfied
 * structurally by `ResourceContext`; a host that composes steps in code supplies
 * its own.
 */
export interface StepEngineContext extends InvokeStepContext {
  ensureKindRef(value: any, resourceName?: string): KindRef;
}

export interface IfStep {
  name: string;
  if: string;
  then: Step[];
  elseif?: Array<{
    if: string;
    then: Step[];
  }>;
  else?: Step[];
}

export interface WhileStep {
  name: string;
  while: string;
  do: Step[];
}

export interface SwitchStep {
  name: string;
  switch: string;
  cases: Record<string, Step[]>;
  default?: Step[];
}

export interface TryStep {
  name: string;
  when?: string;
  try: Step[];
  catch?: Step[];
  finally?: Step[];
}

export interface ThrowStep {
  name: string;
  throw: {
    code: string;
    message?: string;
    data?: unknown;
  };
}

export interface ValueStep {
  name: string;
  value: unknown;
}

export type Step =
  | InvokeStep
  | IfStep
  | WhileStep
  | SwitchStep
  | TryStep
  | ThrowStep
  | ValueStep;

/** Code assigned to any caught failure that is not a structured `InvokeError`.
 *  Guarantees `error.code` is always a non-empty string inside a `catch`, so a
 *  `throw: { code: "${{ error.code }}" }` rethrow can never resolve to null.
 *  The analyzer's throws resolver mirrors this constant. */
export const PLAIN_ERROR_CODE = "INTERNAL_ERROR";

/** The `error` variable a `catch:` / `catches:` branch sees. */
export interface SequenceError {
  message: string;
  code: string;
  data?: unknown;
  step: string;
}

function isInvokeStep(step: Step): step is InvokeStep {
  return "invoke" in step;
}
function isIfStep(step: Step): step is IfStep {
  return "if" in step;
}
function isWhileStep(step: Step): step is WhileStep {
  return "while" in step;
}
function isSwitchStep(step: Step): step is SwitchStep {
  return "switch" in step;
}
function isTryStep(step: Step): step is TryStep {
  return "try" in step;
}
function isThrowStep(step: Step): step is ThrowStep {
  return "throw" in step;
}
function isValueStep(step: Step): step is ValueStep {
  return "value" in step;
}

/**
 * Who is running this body — the two facts the generated name of an inline
 * `invoke:` is built from.
 *
 * Taken as identity rather than as a finished prefix because that name is
 * MANIFEST-VISIBLE topology: it is what `steps.<name>.result`, a trace span and
 * an `ERR_RESOURCE_NOT_FOUND` all print. Every caller used to spell the recipe
 * itself (`` `Iteration${pascalCase(name)}` ``), which is the half of a
 * must-not-fork component that forked anyway — the fifth composer would get the
 * casing subtly wrong, or collide with the fourth.
 */
export interface StepBodyOwner {
  /** The owning kind's suffix (`Sequence`, `Iteration`, `Transaction`). */
  kind: string;
  /** The owning resource's `metadata.name`. */
  resourceName: string;
}

/** Runs a step list against an `extraCtx` CEL scope, owning the full grammar —
 *  `invoke` / `value` / `if` / `while` / `switch` / `try` / `throw`. A composing
 *  kind injects its own scope variables (`item`, `index`, `iteration`,
 *  `previous`, …) through `extraCtx`; the engine knows none of them. */
export class StepEngine {
  /** Prefix for generated inline-invoke resource names; unique per host resource
   *  (`SequenceMySeq`, `LoopPollUntilReady`). */
  private readonly namePrefix: string;

  constructor(
    private readonly ctx: StepEngineContext,
    owner: StepBodyOwner,
  ) {
    this.namePrefix = `${pascalCase(owner.kind)}${pascalCase(owner.resourceName)}`;
  }

  resolveInvokes(stepList: Step[], path: string[] = ["steps"]): void {
    for (const [index, step] of stepList.entries()) {
      const stepPath = [...path, String(index)];
      if (isInvokeStep(step)) {
        const raw = step.invoke as unknown;
        if (!raw || typeof (raw as Invocable).invoke !== "function") {
          (step as InvokeStep).invoke = this.ctx.ensureKindRef(
            raw as any,
            this.inlineInvokeResourceName(step.name, stepPath),
          ) as KindRef<Invocable>;
        }
      }
      if (isIfStep(step)) {
        this.resolveInvokes(step.then, [...stepPath, "then"]);
        if (step.elseif) {
          for (const [elseifIndex, branch] of step.elseif.entries()) {
            this.resolveInvokes(branch.then, [...stepPath, "elseif", String(elseifIndex), "then"]);
          }
        }
        if (step.else) this.resolveInvokes(step.else, [...stepPath, "else"]);
      }
      if (isWhileStep(step)) this.resolveInvokes(step.do, [...stepPath, "do"]);
      if (isSwitchStep(step)) {
        for (const [caseName, branch] of Object.entries(step.cases)) {
          this.resolveInvokes(branch, [...stepPath, "cases", caseName]);
        }
        if (step.default) this.resolveInvokes(step.default, [...stepPath, "default"]);
      }
      if (isTryStep(step)) {
        this.resolveInvokes(step.try, [...stepPath, "try"]);
        if (step.catch) this.resolveInvokes(step.catch, [...stepPath, "catch"]);
        if (step.finally) this.resolveInvokes(step.finally, [...stepPath, "finally"]);
      }
    }
  }

  private inlineInvokeResourceName(stepName: string, stepPath: string[]): string {
    const path = stepPath.map(pascalCase).join("");
    const step = pascalCase(stepName);
    return `${this.namePrefix}${path}${step}`;
  }

  async executeSteps(
    stepList: Step[],
    steps: Record<string, unknown>,
    scope: ScopeContext | undefined,
    extraCtx: Record<string, unknown>,
    invokeCtx?: InvokeContext,
  ): Promise<void> {
    for (const step of stepList) {
      await this.executeStep(step, steps, scope, extraCtx, invokeCtx);
    }
  }

  private async executeStep(
    step: Step,
    steps: Record<string, unknown>,
    scope: ScopeContext | undefined,
    extraCtx: Record<string, unknown>,
    invokeCtx?: InvokeContext,
  ): Promise<void> {
    if (isInvokeStep(step))
      await executeInvokeStep(step, this.ctx, { steps, scope, cel: extraCtx, invokeCtx });
    else if (isIfStep(step)) await this.executeIfStep(step, steps, scope, extraCtx, invokeCtx);
    else if (isWhileStep(step)) await this.executeWhileStep(step, steps, scope, extraCtx, invokeCtx);
    else if (isSwitchStep(step))
      await this.executeSwitchStep(step, steps, scope, extraCtx, invokeCtx);
    else if (isTryStep(step)) await this.executeTryStep(step, steps, scope, extraCtx, invokeCtx);
    else if (isThrowStep(step)) this.executeThrowStep(step, steps, extraCtx);
    else if (isValueStep(step)) this.executeValueStep(step, steps, extraCtx);
    else throw new Error(`Step "${(step as Step).name}" has no recognized type key`);
  }

  private async executeIfStep(
    step: IfStep,
    steps: Record<string, unknown>,
    scope: ScopeContext | undefined,
    extraCtx: Record<string, unknown>,
    invokeCtx?: InvokeContext,
  ): Promise<void> {
    if (this.ctx.expandValue(step.if, { steps, ...extraCtx })) {
      await this.executeSteps(step.then, steps, scope, extraCtx, invokeCtx);
      return;
    }

    if (step.elseif) {
      for (const branch of step.elseif) {
        if (this.ctx.expandValue(branch.if, { steps, ...extraCtx })) {
          await this.executeSteps(branch.then, steps, scope, extraCtx, invokeCtx);
          return;
        }
      }
    }

    if (step.else) {
      await this.executeSteps(step.else, steps, scope, extraCtx, invokeCtx);
    }
  }

  private async executeWhileStep(
    step: WhileStep,
    steps: Record<string, unknown>,
    scope: ScopeContext | undefined,
    extraCtx: Record<string, unknown>,
    invokeCtx?: InvokeContext,
  ): Promise<void> {
    while (this.ctx.expandValue(step.while, { steps, ...extraCtx })) {
      await this.executeSteps(step.do, steps, scope, extraCtx, invokeCtx);
    }
  }

  private async executeSwitchStep(
    step: SwitchStep,
    steps: Record<string, unknown>,
    scope: ScopeContext | undefined,
    extraCtx: Record<string, unknown>,
    invokeCtx?: InvokeContext,
  ): Promise<void> {
    const key = String(this.ctx.expandValue(step.switch, { steps, ...extraCtx }));
    if (Object.prototype.hasOwnProperty.call(step.cases, key)) {
      await this.executeSteps(step.cases[key], steps, scope, extraCtx, invokeCtx);
    } else if (step.default) {
      await this.executeSteps(step.default, steps, scope, extraCtx, invokeCtx);
    } else {
      throw new Error(`Switch step "${step.name}": no matching case for "${key}" and no default`);
    }
  }

  /** A pure step: expand the expression in the step scope and publish it as
   *  `steps.<name>.result`, the same shape an invoke step records — so a
   *  downstream step cannot tell how the value was produced. Nothing is
   *  dispatched, so there is no span and no topology edge. */
  private executeValueStep(
    step: ValueStep,
    steps: Record<string, unknown>,
    extraCtx: Record<string, unknown>,
  ): void {
    try {
      steps[step.name] = { result: this.ctx.expandValue(step.value, { steps, ...extraCtx }) };
    } catch (err) {
      // Attribute the failure the way every other step branch does — a bare
      // expression error names no step, no resource and no line, which is the
      // one thing a `catch:` and a stack trace both need.
      const failure = toSequenceError(err, step.name);
      throw new InvokeError(failure.code, `Step "${step.name}": ${failure.message}`, {
        step: step.name,
        data: failure.data,
      });
    }
  }

  private executeThrowStep(
    step: ThrowStep,
    steps: Record<string, unknown>,
    extraCtx: Record<string, unknown>,
  ): never {
    const cel = { steps, ...extraCtx };
    const expanded = this.ctx.expandValue(step.throw, cel) as {
      code: unknown;
      message?: unknown;
      data?: unknown;
    };
    const code = expanded?.code;
    if (typeof code !== "string" || code.length === 0) {
      // Structured error (not plain Error) so the failure stays in the InvokeError
      // channel and a route's `catches:` list can still map it. The alternative —
      // a plain Error — would skip catches: entirely and fall through to a 500.
      throw new InvokeError(
        "INVALID_THROW_STEP",
        `throw.code is required and must resolve to a non-empty string (step "${step.name}")`,
        { step: step.name, code },
      );
    }
    const message = typeof expanded.message === "string" ? expanded.message : code;
    throw new InvokeError(code, message, expanded.data);
  }

  private async executeTryStep(
    step: TryStep,
    steps: Record<string, unknown>,
    scope: ScopeContext | undefined,
    extraCtx: Record<string, unknown>,
    invokeCtx?: InvokeContext,
  ): Promise<void> {
    if (step.when !== undefined && !this.ctx.expandValue(step.when, { steps, ...extraCtx })) return;

    let tryFailed = false;
    let tryError: unknown;

    try {
      await this.executeSteps(step.try, steps, scope, extraCtx, invokeCtx);
    } catch (err) {
      tryFailed = true;
      tryError = err;
    }

    if (tryFailed) {
      if (step.catch) {
        const seqErr = toSequenceError(tryError, step.name);
        try {
          await this.executeSteps(step.catch, steps, scope, { ...extraCtx, error: seqErr }, invokeCtx);
        } catch (catchErr) {
          if (step.finally) {
            await this.executeSteps(step.finally, steps, scope, {
              ...extraCtx,
              error: toSequenceError(catchErr, step.name),
            }, invokeCtx);
          }
          throw catchErr;
        }
        if (step.finally) {
          await this.executeSteps(step.finally, steps, scope, { ...extraCtx, error: null }, invokeCtx);
        }
      } else {
        if (step.finally) {
          await this.executeSteps(step.finally, steps, scope, {
            ...extraCtx,
            error: toSequenceError(tryError, step.name),
          }, invokeCtx);
        }
        throw tryError;
      }
    } else if (step.finally) {
      await this.executeSteps(step.finally, steps, scope, { ...extraCtx, error: null }, invokeCtx);
    }
  }
}


/** The naming recipe for a generated inline-invoke resource. Module-private: it
 *  is the engine's own, and a bare `pascalCase` on the SDK's flat surface is a
 *  utility nobody should be reimplementing a name from. */
function pascalCase(s: string): string {
  return s
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join("");
}

/** Normalize any caught failure to the `error` shape a `catch:` branch reads.
 *  Shared with the composers' whole-operation `catches:`, so one caught failure
 *  has one shape wherever it is read. */
export function toSequenceError(err: unknown, stepName: string): SequenceError {
  if (isInvokeError(err)) {
    // InvokeError.code is not validated non-empty at construction, so fall back
    // to PLAIN_ERROR_CODE; message then falls back to the resolved code. Keeps
    // both fields non-empty (see PLAIN_ERROR_CODE).
    const code = err.code || PLAIN_ERROR_CODE;
    return { message: err.message || code, code, data: err.data, step: stepName };
  }
  const message = (err instanceof Error ? err.message : String(err)) || "Unknown error";
  return { message, code: PLAIN_ERROR_CODE, data: undefined, step: stepName };
}
