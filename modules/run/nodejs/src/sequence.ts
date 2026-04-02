import type { Invocable, KindRef, ResourceContext, ScopeContext, ScopeHandle } from "@telorun/sdk";

interface RetryPolicy {
  attempts?: number;
  delay?: string;
}

interface InvokeStep {
  name: string;
  when?: string;
  invoke: KindRef<Invocable>;
  inputs?: Record<string, unknown>;
  retry?: RetryPolicy;
}

interface IfStep {
  name: string;
  if: string;
  then: Step[];
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

type Step = InvokeStep | IfStep | WhileStep | SwitchStep | TryStep;

interface RunSequenceManifest {
  metadata: Record<string, string | number | boolean>;
  with?: ScopeHandle;
  targets?: string[];
  inputs?: Record<string, Record<string, unknown>>;
  outputs?: Record<string, unknown>;
  steps: Step[];
}

interface SequenceError {
  message: string;
  code: string | null;
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

class RunSequence {
  constructor(
    private readonly ctx: ResourceContext,
    public readonly resource: RunSequenceManifest,
  ) {}

  async init(): Promise<void> {
    this.resolveInvokes(this.resource.steps);
  }

  private resolveInvokes(stepList: Step[]): void {
    for (const step of stepList) {
      if (isInvokeStep(step)) {
        const raw = step.invoke as unknown;
        if (!raw || typeof (raw as Invocable).invoke !== "function") {
          (step as InvokeStep).invoke = this.ctx.resolveChildren(
            raw as any,
            step.name,
          ) as KindRef<Invocable>;
        }
      }
      if (isIfStep(step)) {
        this.resolveInvokes(step.then);
        if (step.else) this.resolveInvokes(step.else);
      }
      if (isWhileStep(step)) this.resolveInvokes(step.do);
      if (isSwitchStep(step)) {
        for (const branch of Object.values(step.cases)) this.resolveInvokes(branch);
        if (step.default) this.resolveInvokes(step.default);
      }
      if (isTryStep(step)) {
        this.resolveInvokes(step.try);
        if (step.catch) this.resolveInvokes(step.catch);
        if (step.finally) this.resolveInvokes(step.finally);
      }
    }
  }

  async run(): Promise<void> {
    if (this.resource.with) {
      await this.resource.with.run(async (scope) => {
        await this.runScopeTargets(scope);
        await this.executeSteps(this.resource.steps, {}, scope, {});
      });
    } else {
      await this.executeSteps(this.resource.steps, {}, undefined, {});
    }
  }

  async invoke(inputs: Record<string, unknown>): Promise<unknown> {
    const steps: Record<string, unknown> = {};
    const extraCtx = inputs ?? {};

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
      this.resource.targets.map((name) => {
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
    if (isInvokeStep(step)) await this.executeInvokeStep(step, steps, scope, extraCtx);
    else if (isIfStep(step)) await this.executeIfStep(step, steps, scope, extraCtx);
    else if (isWhileStep(step)) await this.executeWhileStep(step, steps, scope, extraCtx);
    else if (isSwitchStep(step)) await this.executeSwitchStep(step, steps, scope, extraCtx);
    else if (isTryStep(step)) await this.executeTryStep(step, steps, scope, extraCtx);
    else throw new Error(`Step "${(step as Step).name}" has no recognized type key`);
  }

  private async executeInvokeStep(
    step: InvokeStep,
    steps: Record<string, unknown>,
    scope: ScopeContext | undefined,
    extraCtx: Record<string, unknown>,
  ): Promise<void> {
    const cel = { steps, ...extraCtx };
    if (step.when !== undefined && !this.ctx.expandValue(step.when, cel)) return;

    const inputs = this.ctx.expandValue(step.inputs ?? {}, cel) as Record<string, unknown>;
    const raw = step.invoke as unknown;
    let result: unknown;

    if (raw && typeof (raw as Invocable).invoke === "function") {
      result = await (raw as Invocable).invoke(inputs);
    } else {
      const ref = raw as KindRef<Invocable>;
      if (scope) {
        result = await (scope.getInstance(ref.name) as unknown as Invocable).invoke(inputs);
      } else {
        result = await this.ctx.invoke(ref.kind, ref.name, inputs, { retry: step.retry });
      }
    }

    steps[step.name] = { result };
  }

  private async executeIfStep(
    step: IfStep,
    steps: Record<string, unknown>,
    scope: ScopeContext | undefined,
    extraCtx: Record<string, unknown>,
  ): Promise<void> {
    if (this.ctx.expandValue(step.if, { steps, ...extraCtx })) {
      await this.executeSteps(step.then, steps, scope, extraCtx);
    } else if (step.else) {
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

function toSequenceError(err: unknown, stepName: string): SequenceError {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    err instanceof Error && (err as Error & { code?: string }).code != null
      ? (err as Error & { code?: string }).code!
      : null;
  return { message, code, step: stepName };
}

export function register(): void {}

export async function create(
  resource: RunSequenceManifest,
  ctx: ResourceContext,
): Promise<RunSequence> {
  return new RunSequence(ctx, resource);
}
