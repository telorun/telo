import {
  executeInvokeStep,
  InvokeError,
  isInvokeError,
  type Invocable,
  type InvokeStep,
  type KindRef,
  type ResourceContext,
  type ScopeContext,
  type ScopeHandle,
} from "@telorun/sdk";

interface IfStep {
  name: string;
  if: string;
  then: Step[];
  elseif?: Array<{
    if: string;
    then: Step[];
  }>;
  else?: Step[];
}

interface WhileStep {
  name: string;
  while: string;
  do: Step[];
}

interface SwitchStep {
  name: string;
  switch: string;
  cases: Record<string, Step[]>;
  default?: Step[];
}

interface TryStep {
  name: string;
  when?: string;
  try: Step[];
  catch?: Step[];
  finally?: Step[];
}

interface ThrowStep {
  name: string;
  throw: {
    code: string;
    message?: string;
    data?: unknown;
  };
}

type Step = InvokeStep | IfStep | WhileStep | SwitchStep | TryStep | ThrowStep;

/** Read the referenced resource name from a `targets` entry. After `!ref`
 *  resolution the entry is a `{kind, name}` reference; an unresolved `!ref`
 *  sentinel (`{__tagged, engine: "ref", source}`) carries the name as `source`.
 *  Scope targets are always with-resources, so the name is resolved against the
 *  scope (never Phase-5-injected into a live instance). */
function scopeTargetName(target: unknown): string {
  if (target && typeof target === "object") {
    const ref = target as { name?: unknown; source?: unknown };
    if (typeof ref.name === "string") return ref.name;
    if (typeof ref.source === "string") {
      const dot = ref.source.lastIndexOf(".");
      return dot >= 0 ? ref.source.slice(dot + 1) : ref.source;
    }
  }
  throw new Error(`Run.Sequence target is not a resource reference: ${JSON.stringify(target)}`);
}

interface RunSequenceManifest {
  metadata: Record<string, string | number | boolean>;
  with?: ScopeHandle;
  targets?: unknown[];
  inputs?: Record<string, Record<string, unknown>>;
  outputs?: Record<string, unknown>;
  steps: Step[];
}

/** Code assigned to any caught failure that is not a structured `InvokeError`.
 *  Guarantees `error.code` is always a non-empty string inside a `catch`, so a
 *  `throw: { code: "${{ error.code }}" }` rethrow can never resolve to null.
 *  The analyzer's throws resolver mirrors this constant. */
const PLAIN_ERROR_CODE = "INTERNAL_ERROR";

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

class RunSequence {
  constructor(
    private readonly ctx: ResourceContext,
    public readonly resource: RunSequenceManifest,
  ) {}

  async init(): Promise<void> {
    this.resolveInvokes(this.resource.steps);
  }

  private resolveInvokes(stepList: Step[], path: string[] = ["steps"]): void {
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
    const seq = pascalCase(String(this.resource.metadata.name));
    const path = stepPath.map(pascalCase).join("");
    const step = pascalCase(stepName);
    return `Sequence${seq}${path}${step}`;
  }

  async run(): Promise<void> {
    if (this.resource.with) {
      await this.resource.with.run(async (scope) => {
        await this.runScopeTargets(scope);
        await this.executeSteps(this.resource.steps, {}, scope, { inputs: {} });
      });
    } else {
      await this.executeSteps(this.resource.steps, {}, undefined, { inputs: {} });
    }
  }

  async invoke(inputs: Record<string, unknown>): Promise<unknown> {
    const steps: Record<string, unknown> = {};
    // Caller inputs are exposed under the `inputs` CEL variable (not spread
    // flat) so steps read them as `${{ inputs.x }}`, matching the documented
    // contract. `error` is threaded as a sibling key inside try/catch.
    const extraCtx = { inputs: inputs ?? {} };

    if (this.resource.with) {
      await this.resource.with.run(async (scope) => {
        await this.runScopeTargets(scope);
        await this.executeSteps(this.resource.steps, steps, scope, extraCtx);
      });
    } else {
      await this.executeSteps(this.resource.steps, steps, undefined, extraCtx);
    }

    if (this.resource.outputs) {
      return this.ctx.expandValue(this.resource.outputs, { steps, ...extraCtx });
    }
    return steps;
  }

  private async runScopeTargets(scope: ScopeContext): Promise<void> {
    if (!this.resource.targets?.length) return;
    await Promise.all(
      this.resource.targets.map((target) => {
        const name = scopeTargetName(target);
        const instance = scope.getInstance(name);
        if (typeof instance.run !== "function") {
          throw new Error(`Scope target '${name}' does not have a run() method`);
        }
        return instance.run();
      }),
    );
  }

  async teardown(): Promise<void> {}

  private async executeSteps(
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
        `Run.Sequence step "${step.name}": throw.code is required and must resolve to a non-empty string`,
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

function pascalCase(s: string): string {
  return s
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join("");
}

function toSequenceError(err: unknown, stepName: string): SequenceError {
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

export function register(): void {}

export async function create(
  resource: RunSequenceManifest,
  ctx: ResourceContext,
): Promise<RunSequence> {
  return new RunSequence(ctx, resource);
}
