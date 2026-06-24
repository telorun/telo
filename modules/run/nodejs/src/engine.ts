import {
  executeInvokeStep,
  InvokeError,
  isInvokeError,
  type Invocable,
  type InvokeStep,
  type KindRef,
  type ResourceContext,
  type ScopeContext,
} from "@telorun/sdk";

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

export type Step = InvokeStep | IfStep | WhileStep | SwitchStep | TryStep | ThrowStep;

/** Code assigned to any caught failure that is not a structured `InvokeError`.
 *  Guarantees `error.code` is always a non-empty string inside a `catch`, so a
 *  `throw: { code: "${{ error.code }}" }` rethrow can never resolve to null.
 *  The analyzer's throws resolver mirrors this constant. */
export const PLAIN_ERROR_CODE = "INTERNAL_ERROR";

interface SequenceError {
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

/** Shared step-execution engine for `Run.Sequence` and the binding-wrapper kinds
 *  (`Run.Loop`, `Run.Iteration`, `Run.Projection`). It owns the full step grammar
 *  — `invoke` / `if` / `while` / `switch` / `try` / `throw` — and runs a step list
 *  against an `extraCtx` CEL scope. The wrapper kinds inject extra scope variables
 *  (`item`, `index`, `iteration`, `previous`, …) via `extraCtx`; their schemas
 *  simply omit the `while` block, but the engine handling it stays whole. */
export class StepEngine {
  constructor(
    private readonly ctx: ResourceContext,
    /** Prefix for generated inline-invoke resource names; keeps names unique per
     *  host resource (e.g. `SequenceMySeq`, `LoopPollUntilReady`). */
    private readonly namePrefix: string,
  ) {}

  resolveInvokes(stepList: Step[], path: string[] = ["steps"]): void {
    for (const [index, step] of stepList.entries()) {
      const stepPath = [...path, String(index)];
      if (isInvokeStep(step)) {
        const raw = step.invoke as unknown;
        if (!raw || typeof (raw as Invocable).invoke !== "function") {
          (step as InvokeStep).invoke = this.ctx.resolveChildren(
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
  ): Promise<void> {
    for (const step of stepList) {
      await this.executeStep(step, steps, scope, extraCtx);
    }
  }

  private async executeStep(
    step: Step,
    steps: Record<string, unknown>,
    scope: ScopeContext | undefined,
    extraCtx: Record<string, unknown>,
  ): Promise<void> {
    if (isInvokeStep(step)) await executeInvokeStep(step, this.ctx, { steps, scope, cel: extraCtx });
    else if (isIfStep(step)) await this.executeIfStep(step, steps, scope, extraCtx);
    else if (isWhileStep(step)) await this.executeWhileStep(step, steps, scope, extraCtx);
    else if (isSwitchStep(step)) await this.executeSwitchStep(step, steps, scope, extraCtx);
    else if (isTryStep(step)) await this.executeTryStep(step, steps, scope, extraCtx);
    else if (isThrowStep(step)) this.executeThrowStep(step, steps, extraCtx);
    else throw new Error(`Step "${(step as Step).name}" has no recognized type key`);
  }

  private async executeIfStep(
    step: IfStep,
    steps: Record<string, unknown>,
    scope: ScopeContext | undefined,
    extraCtx: Record<string, unknown>,
  ): Promise<void> {
    if (this.ctx.expandValue(step.if, { steps, ...extraCtx })) {
      await this.executeSteps(step.then, steps, scope, extraCtx);
      return;
    }

    if (step.elseif) {
      for (const branch of step.elseif) {
        if (this.ctx.expandValue(branch.if, { steps, ...extraCtx })) {
          await this.executeSteps(branch.then, steps, scope, extraCtx);
          return;
        }
      }
    }

    if (step.else) {
      await this.executeSteps(step.else, steps, scope, extraCtx);
    }
  }

  private async executeWhileStep(
    step: WhileStep,
    steps: Record<string, unknown>,
    scope: ScopeContext | undefined,
    extraCtx: Record<string, unknown>,
  ): Promise<void> {
    while (this.ctx.expandValue(step.while, { steps, ...extraCtx })) {
      await this.executeSteps(step.do, steps, scope, extraCtx);
    }
  }

  private async executeSwitchStep(
    step: SwitchStep,
    steps: Record<string, unknown>,
    scope: ScopeContext | undefined,
    extraCtx: Record<string, unknown>,
  ): Promise<void> {
    const key = String(this.ctx.expandValue(step.switch, { steps, ...extraCtx }));
    if (Object.prototype.hasOwnProperty.call(step.cases, key)) {
      await this.executeSteps(step.cases[key], steps, scope, extraCtx);
    } else if (step.default) {
      await this.executeSteps(step.default, steps, scope, extraCtx);
    } else {
      throw new Error(`Switch step "${step.name}": no matching case for "${key}" and no default`);
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
  ): Promise<void> {
    if (step.when !== undefined && !this.ctx.expandValue(step.when, { steps, ...extraCtx })) return;

    let tryFailed = false;
    let tryError: unknown;

    try {
      await this.executeSteps(step.try, steps, scope, extraCtx);
    } catch (err) {
      tryFailed = true;
      tryError = err;
    }

    if (tryFailed) {
      if (step.catch) {
        const seqErr = toSequenceError(tryError, step.name);
        try {
          await this.executeSteps(step.catch, steps, scope, { ...extraCtx, error: seqErr });
        } catch (catchErr) {
          if (step.finally) {
            await this.executeSteps(step.finally, steps, scope, {
              ...extraCtx,
              error: toSequenceError(catchErr, step.name),
            });
          }
          throw catchErr;
        }
        if (step.finally) {
          await this.executeSteps(step.finally, steps, scope, { ...extraCtx, error: null });
        }
      } else {
        if (step.finally) {
          await this.executeSteps(step.finally, steps, scope, {
            ...extraCtx,
            error: toSequenceError(tryError, step.name),
          });
        }
        throw tryError;
      }
    } else if (step.finally) {
      await this.executeSteps(step.finally, steps, scope, { ...extraCtx, error: null });
    }
  }
}

export interface CatchEntry {
  when?: string;
  value?: unknown;
}

/** Whole-operation error contract shared by the binding-wrapper kinds. Runs
 *  `body`; if it throws and a `catches` entry's `when` matches (CEL over `error`
 *  + `inputs`), resolves to that entry's `value` instead of propagating. An
 *  unmatched throw (or no `catches`) propagates — fail-fast. */
export async function withCatches<T>(
  ctx: ResourceContext,
  catches: CatchEntry[] | undefined,
  inputs: Record<string, unknown>,
  operationName: string,
  body: () => Promise<T>,
): Promise<T> {
  try {
    return await body();
  } catch (err) {
    if (!catches?.length) throw err;
    const error = toSequenceError(err, operationName);
    for (const entry of catches) {
      const matched = entry.when === undefined ? true : ctx.expandValue(entry.when, { error, inputs });
      if (matched) {
        return ctx.expandValue(entry.value ?? null, { error, inputs }) as T;
      }
    }
    throw err;
  }
}

/** Resolve a `concurrency` field — a raw CEL value (`!cel`) or literal — to a
 *  positive integer. The schema does not auto-eval the field, so the controller
 *  must expand it itself (mirroring Run.Loop's `maxIterations`); reading it raw
 *  leaves a CompiledValue that `mapConcurrent` would turn into zero workers and a
 *  silent `[null, …]`. Defaults to 1 when omitted. */
export function resolveConcurrency(
  ctx: ResourceContext,
  raw: unknown,
  inputs: Record<string, unknown>,
  operationName: string,
): number {
  if (raw === undefined) return 1;
  const resolved = ctx.expandValue(raw, { inputs });
  const value = Number(resolved);
  if (!Number.isInteger(value) || value < 1) {
    throw new InvokeError(
      "INVALID_CONCURRENCY",
      `${operationName}: concurrency must resolve to an integer >= 1, got ${JSON.stringify(resolved)}`,
    );
  }
  return value;
}

/** Map `items` through `fn` with a bounded worker pool. `concurrency` 1 runs
 *  strictly ordered; `>1` runs that many in flight. Results are written by index
 *  so the returned array preserves input order regardless of completion order.
 *  Fail-fast: on the first rejection no further items are scheduled and the
 *  first error propagates (in-flight items settle but their results are dropped). */
export async function mapConcurrent<I, O>(
  items: readonly I[],
  concurrency: number,
  fn: (item: I, index: number) => Promise<O>,
): Promise<O[]> {
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    // Defence in depth: callers resolve concurrency to a validated integer. A
    // non-finite value here would zero the worker pool and silently return a
    // sparse array — surface it instead.
    throw new InvokeError(
      "INVALID_CONCURRENCY",
      `mapConcurrent: concurrency must be a positive integer, got ${concurrency}`,
    );
  }
  const results: O[] = new Array(items.length);
  const limit = Math.max(1, Math.floor(concurrency));
  let next = 0;
  let failure: { err: unknown } | undefined;

  async function worker(): Promise<void> {
    while (failure === undefined) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        if (failure === undefined) failure = { err };
        return;
      }
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (failure !== undefined) throw failure.err;
  return results;
}

export function pascalCase(s: string): string {
  return s
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join("");
}

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
