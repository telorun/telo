/**
 * `Durable.Idempotent` — a region whose author asserts re-running it is a no-op.
 *
 * The controller is almost nothing, and that is the design working: everything
 * this kind does is *declare*. The `idempotent` zone attribute on its `steps:`
 * slot is what a durable step engine reads to collapse the region to one record,
 * and the attribute is read off the schema rather than reported by this code —
 * so the claim lives where a reviewer reads the manifest, not where only a
 * maintainer reads TypeScript.
 *
 * What is left here is opening the zone (a body slot that declares a property of
 * its contents has to actually establish the region at runtime) and running the
 * body.
 */
import {
  StepEngine,
  type InvokeContext,
  type ResourceContext,
  type ResourceManifest,
  type Step,
} from "@telorun/sdk";

interface IdempotentManifest extends ResourceManifest {
  reason: string;
  steps: Step[];
  inputs?: Record<string, unknown>;
}

class IdempotentController {
  private readonly engine: StepEngine;

  constructor(
    private readonly resource: IdempotentManifest,
    private readonly ctx: ResourceContext,
  ) {
    this.engine = new StepEngine(ctx, {
      kind: "Idempotent",
      resourceName: String(resource.metadata.name),
    });
  }

  async init(): Promise<void> {
    this.engine.resolveInvokes(this.resource.steps);
  }

  async invoke(input: unknown, invokeCtx?: InvokeContext): Promise<unknown> {
    const cel = { inputs: input ?? {} };
    const inputs = this.ctx.expandValue(this.resource.inputs ?? {}, cel) as Record<string, unknown>;
    const steps: Record<string, unknown> = {};

    // "You are inside my body" is what the zone expresses, and the region's
    // property travels with it. The derived context is threaded into the body
    // rather than left ambient — the discipline cancellation already has, and
    // the only one a runtime without an ambient store could implement.
    await this.ctx.withZone(
      "steps",
      (zoneCtx) => this.engine.executeSteps(this.resource.steps, steps, undefined, { inputs }, zoneCtx),
      invokeCtx,
    );

    return { steps };
  }

  snapshot(): Record<string, unknown> {
    return { reason: this.resource.reason };
  }
}

export function register(): void {}

export async function create(
  resource: IdempotentManifest,
  ctx: ResourceContext,
): Promise<IdempotentController> {
  return new IdempotentController(resource, ctx);
}
