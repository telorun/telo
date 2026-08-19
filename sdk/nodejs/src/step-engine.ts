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
import {
  durableHandleOf,
  journalingSuppressed,
  stepPath,
  type DurableDecisionKind,
  type DurableRunHandle,
} from "./durable-run.js";
import { isSuspension } from "./durable-suspension.js";
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

  /**
   * @param path Journal key prefix for this list — see {@link stepPath}. A
   *   composer that repeats a body (an iteration element, a loop turn) qualifies
   *   it with the index, which is what makes each repetition an independently
   *   resumable subtree. Omitted, it is derived from the ambient step path, so a
   *   NESTED body nests its keys instead of restarting at the root — see
   *   {@link baseStepPath}.
   */
  async executeSteps(
    stepList: Step[],
    steps: Record<string, unknown>,
    scope: ScopeContext | undefined,
    extraCtx: Record<string, unknown>,
    invokeCtx?: InvokeContext,
    path?: string,
  ): Promise<void> {
    const base = path ?? baseStepPath(invokeCtx);
    for (const step of stepList) {
      await this.executeStep(step, steps, scope, extraCtx, invokeCtx, base);
    }
  }

  /**
   * The journal key of one step.
   *
   * Composed from the WRITTEN structure — the enclosing list's path plus this
   * step's own name — never from execution order. A per-run call ordinal would
   * be simpler and is wrong: two branches of a concurrent fan-out interleave
   * their dispatches, so an ordinal numbers them differently on every run while
   * these paths stay fixed.
   */
  private pathOf(path: string, step: Step): string {
    // A missing name is refused rather than defaulted. The shared `Step` schema
    // declares `name` required, so a manifest cannot reach this — but a caller
    // assembling steps in code can, and an empty segment would give two such
    // steps ONE journal key, where first-writer-wins hands the second the
    // first's result. Silent, and indistinguishable from a correct replay.
    if (!step.name) {
      throw new InvokeError(
        "ERR_STEP_NAME_REQUIRED",
        `A step at '${path}' has no name. A name is what identifies the step in the run's ` +
          `record, so two unnamed steps would share one key and the second would be handed ` +
          `the first's result.`,
        { path },
      );
    }
    return stepPath(path, step.name);
  }

  /** The run handle to journal through, or undefined when this body is not
   *  inside a durable run — in which case the engine behaves exactly as it did
   *  before durability existed, and pays nothing for it. */
  private handle(invokeCtx?: InvokeContext): DurableRunHandle | undefined {
    return durableHandleOf(invokeCtx);
  }

  /**
   * Evaluate a control-flow decision, journaling it when a run is durable.
   *
   * EVERY decision goes through here, which is the closure property the whole
   * design rests on: a predicate, a loop condition and a switch key are all read
   * from a CEL scope carrying live readings, so re-deriving one in a fresh
   * process can send the replay down a different branch than the run took —
   * silently, because the journal would then hand back a recorded result under a
   * key the run reached for a different reason.
   */
  private async decide<T>(
    invokeCtx: InvokeContext | undefined,
    path: string,
    kind: DurableDecisionKind,
    compute: () => T,
  ): Promise<T> {
    const handle = this.handle(invokeCtx);
    if (!handle || journalingSuppressed(this.ctx, invokeCtx, handle)) return compute();
    return handle.decide(path, kind, compute);
  }

  private async executeStep(
    step: Step,
    steps: Record<string, unknown>,
    scope: ScopeContext | undefined,
    extraCtx: Record<string, unknown>,
    invokeCtx?: InvokeContext,
    path = "steps",
  ): Promise<void> {
    const here = this.pathOf(path, step);
    if (isInvokeStep(step))
      await executeInvokeStep(step, this.ctx, {
        steps,
        scope,
        cel: extraCtx,
        invokeCtx,
        journalPath: here,
      });
    else if (isIfStep(step)) await this.executeIfStep(step, steps, scope, extraCtx, invokeCtx, here);
    else if (isWhileStep(step))
      await this.executeWhileStep(step, steps, scope, extraCtx, invokeCtx, here);
    else if (isSwitchStep(step))
      await this.executeSwitchStep(step, steps, scope, extraCtx, invokeCtx, here);
    else if (isTryStep(step))
      await this.executeTryStep(step, steps, scope, extraCtx, invokeCtx, here);
    else if (isThrowStep(step)) this.executeThrowStep(step, steps, extraCtx);
    else if (isValueStep(step)) await this.executeValueStep(step, steps, extraCtx, invokeCtx, here);
    else throw new Error(`Step "${(step as Step).name}" has no recognized type key`);
  }

  private async executeIfStep(
    step: IfStep,
    steps: Record<string, unknown>,
    scope: ScopeContext | undefined,
    extraCtx: Record<string, unknown>,
    invokeCtx?: InvokeContext,
    path = "steps",
  ): Promise<void> {
    // Each predicate is journaled under its own key, so replay takes the branch
    // the RUN took rather than the branch the predicate would evaluate to now.
    if (await this.decide(invokeCtx, stepPath(path, "if"), "predicate", () =>
      this.ctx.expandValue(step.if, { steps, ...extraCtx }),
    )) {
      await this.executeSteps(step.then, steps, scope, extraCtx, invokeCtx, stepPath(path, "then"));
      return;
    }

    if (step.elseif) {
      for (const [index, branch] of step.elseif.entries()) {
        if (await this.decide(invokeCtx, stepPath(path, "elseif", index), "predicate", () =>
          this.ctx.expandValue(branch.if, { steps, ...extraCtx }),
        )) {
          await this.executeSteps(
            branch.then,
            steps,
            scope,
            extraCtx,
            invokeCtx,
            stepPath(path, "elseif", index, "then"),
          );
          return;
        }
      }
    }

    if (step.else) {
      await this.executeSteps(step.else, steps, scope, extraCtx, invokeCtx, stepPath(path, "else"));
    }
  }

  private async executeWhileStep(
    step: WhileStep,
    steps: Record<string, unknown>,
    scope: ScopeContext | undefined,
    extraCtx: Record<string, unknown>,
    invokeCtx?: InvokeContext,
    path = "steps",
  ): Promise<void> {
    // The turn index qualifies both the condition's key and the body's, so each
    // turn is an independently resumable subtree and a resume re-enters the turn
    // it stopped in rather than restarting the loop.
    for (let turn = 0; ; turn++) {
      const go = await this.decide(invokeCtx, stepPath(path, "while", turn), "condition", () =>
        this.ctx.expandValue(step.while, { steps, ...extraCtx }),
      );
      if (!go) return;
      await this.executeSteps(
        step.do,
        steps,
        scope,
        extraCtx,
        invokeCtx,
        stepPath(path, "do", turn),
      );
    }
  }

  private async executeSwitchStep(
    step: SwitchStep,
    steps: Record<string, unknown>,
    scope: ScopeContext | undefined,
    extraCtx: Record<string, unknown>,
    invokeCtx?: InvokeContext,
    path = "steps",
  ): Promise<void> {
    const key = String(
      await this.decide(invokeCtx, stepPath(path, "switch"), "switch", () =>
        this.ctx.expandValue(step.switch, { steps, ...extraCtx }),
      ),
    );
    if (Object.prototype.hasOwnProperty.call(step.cases, key)) {
      await this.executeSteps(
        step.cases[key],
        steps,
        scope,
        extraCtx,
        invokeCtx,
        stepPath(path, "cases", key),
      );
    } else if (step.default) {
      await this.executeSteps(
        step.default,
        steps,
        scope,
        extraCtx,
        invokeCtx,
        stepPath(path, "default"),
      );
    } else {
      throw new Error(`Switch step "${step.name}": no matching case for "${key}" and no default`);
    }
  }

  /** A pure step: expand the expression in the step scope and publish it as
   *  `steps.<name>.result`, the same shape an invoke step records — so a
   *  downstream step cannot tell how the value was produced. Nothing is
   *  dispatched, so there is no span and no topology edge. */
  private async executeValueStep(
    step: ValueStep,
    steps: Record<string, unknown>,
    extraCtx: Record<string, unknown>,
    invokeCtx?: InvokeContext,
    path = "steps",
  ): Promise<void> {
    try {
      // Journaled like any other decision: a pure step's expression may be
      // impure (`now()`, `uuid()`), and its value becomes `steps.<name>.result`
      // that later steps read — so re-deriving it on replay would change the
      // run's state without any dispatch having differed. This is also what lets
      // a `Durable.Value` work INSIDE a collapsed region: collapse suppresses
      // per-step entries, never a direct decision.
      const result = await this.decide(invokeCtx, path, "value", () =>
        this.ctx.expandValue(step.value, { steps, ...extraCtx }),
      );
      steps[step.name] = { result };
    } catch (err) {
      // A suspension is not this step's failure — it is the run leaving —
      // so it passes through unattributed rather than being rewritten into an
      // InvokeError a `catches:` list could name.
      if (isSuspension(err)) throw err;
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
    path = "steps",
  ): Promise<void> {
    if (
      step.when !== undefined &&
      !(await this.decide(invokeCtx, stepPath(path, "when"), "predicate", () =>
        this.ctx.expandValue(step.when, { steps, ...extraCtx }),
      ))
    ) {
      return;
    }

    let tryFailed = false;
    let tryError: unknown;

    try {
      await this.executeSteps(step.try, steps, scope, extraCtx, invokeCtx, stepPath(path, "try"));
    } catch (err) {
      // `try:` must NOT catch a suspension. The signal unwinds to the workflow
      // that owns the run; absorbing it here would run the `catch:` branch and
      // then continue, converting a park into a completed step and duplicating
      // every effect after it. The latch would catch that at the boundary, but
      // a hard error is a worse answer than simply not swallowing it.
      if (isSuspension(err)) throw err;
      tryFailed = true;
      tryError = err;
    }

    if (tryFailed) {
      if (step.catch) {
        const seqErr = toSequenceError(tryError, step.name);
        try {
          await this.executeSteps(
            step.catch,
            steps,
            scope,
            { ...extraCtx, error: seqErr },
            invokeCtx,
            stepPath(path, "catch"),
          );
        } catch (catchErr) {
          if (step.finally) {
            await this.executeSteps(
              step.finally,
              steps,
              scope,
              { ...extraCtx, error: toSequenceError(catchErr, step.name) },
              invokeCtx,
              stepPath(path, "finally"),
            );
          }
          throw catchErr;
        }
        if (step.finally) {
          await this.executeSteps(
            step.finally,
            steps,
            scope,
            { ...extraCtx, error: null },
            invokeCtx,
            stepPath(path, "finally"),
          );
        }
      } else {
        if (step.finally) {
          await this.executeSteps(
            step.finally,
            steps,
            scope,
            { ...extraCtx, error: toSequenceError(tryError, step.name) },
            invokeCtx,
            stepPath(path, "finally"),
          );
        }
        throw tryError;
      }
    } else if (step.finally) {
      await this.executeSteps(
        step.finally,
        steps,
        scope,
        { ...extraCtx, error: null },
        invokeCtx,
        stepPath(path, "finally"),
      );
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

/**
 * Where a step list's journal keys hang from.
 *
 * At the top of a durable run there is no ambient path and the base is `steps`.
 * Inside one, it is the path of the step that dispatched this body — so a nested
 * sequence's `work` becomes `steps/importAll/work` rather than a second
 * `steps/work`, and two nested bodies can no longer collide.
 *
 * The dispatching step's path is used directly rather than with a `steps`
 * segment appended: the parent path already names one dispatch site, and every
 * other segment the grammar produces (`then`, `do[2]`, `cases/x`) is distinct
 * from a step name, so nothing else can generate the same key.
 */
function baseStepPath(invokeCtx?: InvokeContext): string {
  return invokeCtx?.durablePath ?? "steps";
}
