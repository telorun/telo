import { type ResourceContext, type ScopeContext, type ScopeHandle } from "@telorun/sdk";
import { pascalCase, type Step, StepEngine } from "./engine.js";

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

/** Layer the scope's `resources` over the CEL extras so steps can read a
 *  with-resource's published snapshot (`resources.<scopedName>.status.port`).
 *  A live getter, not a copy: the map grows as scope targets start and report,
 *  and each step re-spreads these extras at evaluation time. Outside the scope
 *  the name does not resolve at all, which is already the rule for `!ref`. */
function scopeCel(
  scope: ScopeContext,
  extraCtx: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...extraCtx,
    get resources() {
      return scope.resources;
    },
  };
}

interface RunSequenceManifest {
  metadata: Record<string, string | number | boolean>;
  with?: ScopeHandle;
  targets?: unknown[];
  inputs?: Record<string, Record<string, unknown>>;
  outputs?: Record<string, unknown>;
  steps: Step[];
}

class RunSequence {
  private readonly engine: StepEngine;

  constructor(
    private readonly ctx: ResourceContext,
    public readonly resource: RunSequenceManifest,
  ) {
    this.engine = new StepEngine(ctx, `Sequence${pascalCase(String(resource.metadata.name))}`);
  }

  async init(): Promise<void> {
    this.engine.resolveInvokes(this.resource.steps);
  }

  async run(): Promise<void> {
    if (this.resource.with) {
      await this.resource.with.run(async (scope) => {
        await this.runScopeTargets(scope);
        await this.engine.executeSteps(
          this.resource.steps,
          {},
          scope,
          scopeCel(scope, { inputs: {} }),
        );
      });
    } else {
      await this.engine.executeSteps(this.resource.steps, {}, undefined, { inputs: {} });
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
        await this.engine.executeSteps(this.resource.steps, steps, scope, scopeCel(scope, extraCtx));
      });
    } else {
      await this.engine.executeSteps(this.resource.steps, steps, undefined, extraCtx);
    }

    if (this.resource.outputs) {
      return this.ctx.expandValue(this.resource.outputs, { steps, ...extraCtx });
    }
    return steps;
  }

  private async runScopeTargets(scope: ScopeContext): Promise<void> {
    if (!this.resource.targets?.length) return;
    await Promise.all(
      this.resource.targets.map((target) => scope.run(scopeTargetName(target))),
    );
  }

  async teardown(): Promise<void> {}
}

export function register(): void {}

export async function create(
  resource: RunSequenceManifest,
  ctx: ResourceContext,
): Promise<RunSequence> {
  return new RunSequence(ctx, resource);
}
