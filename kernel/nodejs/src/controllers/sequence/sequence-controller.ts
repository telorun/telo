import {
  getRefIdentity,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
  type ResourceManifest,
  type ScopeContext,
  type ScopeHandle,
  type Step,
  StepEngine,
} from "@telorun/sdk";

/**
 * `Telo.Sequence` — an ordered list of steps behind an invocation contract.
 *
 * A kernel built-in for the reason `Telo.Function` is: the step grammar it runs
 * is core, so declaring one must not require importing a module. The engine's
 * `kind` stays `Sequence`, the name every step's durable identity, span name and
 * inline target name is built from, so a run journaled under the module kind it
 * replaced keeps its identity.
 */

/** Where the body is written in the resource's declaration. */
const STEPS_POINTER = "/steps";

interface SequenceManifest {
  metadata: Record<string, string | number | boolean>;
  with?: ScopeHandle;
  targets?: unknown[];
  outputs?: Record<string, unknown>;
  steps: Step[];
}

/** The name a `targets:` entry names: a resolved `{kind, name}` reference, an
 *  unresolved `!ref` sentinel (its `source`), or a live instance a module-level
 *  resource of the same name was injected as — the scope still resolves the name
 *  scope-locally, so its stamped identity is the answer. */
function scopeTargetName(target: unknown): string {
  if (target && typeof target === "object") {
    const ref = target as { name?: unknown; source?: unknown };
    if (typeof ref.name === "string") return ref.name;
    if (typeof ref.source === "string") {
      const dot = ref.source.lastIndexOf(".");
      return dot >= 0 ? ref.source.slice(dot + 1) : ref.source;
    }
    const identity = getRefIdentity(target);
    if (identity) return identity.name;
  }
  // Never serialized: a live instance may be cyclic.
  throw new Error(
    `Telo.Sequence target is not a resource reference (got ${describeTarget(target)}). ` +
      `Use \`!ref <name>\` naming a resource declared in this sequence's \`with:\`.`,
  );
}

function describeTarget(target: unknown): string {
  if (target === null) return "null";
  if (typeof target !== "object") return typeof target;
  const ctor = (target as { constructor?: { name?: string } }).constructor?.name;
  return ctor && ctor !== "Object" ? `an instance of ${ctor}` : "an object with no 'name'";
}

/** The scope's `resources` layered over the CEL extras as a live getter: the
 *  map grows as scope targets start and report. */
function scopeCel(scope: ScopeContext, extraCtx: Record<string, unknown>): Record<string, unknown> {
  return {
    ...extraCtx,
    get resources() {
      return scope.resources;
    },
  };
}

class Sequence {
  private readonly engine: StepEngine;

  constructor(
    private readonly ctx: ResourceContext,
    public readonly resource: SequenceManifest,
  ) {
    this.engine = new StepEngine(ctx, {
      kind: "Sequence",
      resourceName: String(resource.metadata.name),
    });
  }

  async init(): Promise<void> {
    this.engine.resolveInvokes(this.resource.steps);
  }

  /** A boot run. Its context is the kernel's boot cancellation, forwarded so an
   *  interrupt ends a run parked in a retry backoff. */
  async run(invokeCtx?: InvokeContext): Promise<void> {
    await this.execute({}, { inputs: {} }, invokeCtx);
  }

  /** The invocation context is forwarded to the step leaf, so a retry backoff
   *  between two attempts is a cancellation point too. */
  async invoke(inputs: Record<string, unknown>, invokeCtx?: InvokeContext): Promise<unknown> {
    const steps: Record<string, unknown> = {};
    const extraCtx = { inputs: inputs ?? {} };
    await this.execute(steps, extraCtx, invokeCtx);
    if (this.resource.outputs) {
      return this.ctx.expandValue(this.resource.outputs, { steps, ...extraCtx });
    }
    return steps;
  }

  private async execute(
    steps: Record<string, unknown>,
    extraCtx: Record<string, unknown>,
    invokeCtx: InvokeContext | undefined,
  ): Promise<void> {
    if (!this.resource.with) {
      await this.engine.executeSteps(
        this.resource.steps,
        steps,
        undefined,
        extraCtx,
        invokeCtx,
        undefined,
        STEPS_POINTER,
      );
      return;
    }
    await this.resource.with.run(async (scope) => {
      await this.runScopeTargets(scope);
      await this.engine.executeSteps(
        this.resource.steps,
        steps,
        scope,
        scopeCel(scope, extraCtx),
        invokeCtx,
        undefined,
        STEPS_POINTER,
      );
    });
  }

  private async runScopeTargets(scope: ScopeContext): Promise<void> {
    if (!this.resource.targets?.length) return;
    await Promise.all(this.resource.targets.map((target) => scope.run(scopeTargetName(target))));
  }
}

export async function create(
  resource: ResourceManifest,
  ctx: ResourceContext,
): Promise<ResourceInstance> {
  return new Sequence(ctx, resource as unknown as SequenceManifest) as unknown as ResourceInstance;
}
