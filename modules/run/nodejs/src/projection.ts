import { InvokeError, type ResourceContext } from "@telorun/sdk";
import {
  type CatchEntry,
  mapConcurrent,
  pascalCase,
  type Step,
  StepEngine,
  withCatches,
} from "./engine.js";

interface RunProjectionManifest {
  metadata: Record<string, string | number | boolean>;
  collection: unknown;
  concurrency?: number;
  inputs?: Record<string, unknown>;
  outputs?: unknown;
  catches?: CatchEntry[];
  steps: Step[];
}

/** Runs its `steps` body once per element of `collection` and collects each
 *  element's `outputs` (raw step map when `outputs` is omitted) into an array,
 *  preserving input order even under concurrency. Adds `item` / `index` /
 *  `items` to the body's CEL scope. */
class RunProjection {
  private readonly engine: StepEngine;

  constructor(
    private readonly ctx: ResourceContext,
    private readonly resource: RunProjectionManifest,
  ) {
    this.engine = new StepEngine(ctx, `Projection${pascalCase(String(resource.metadata.name))}`);
  }

  async init(): Promise<void> {
    this.engine.resolveInvokes(this.resource.steps);
  }

  async run(): Promise<void> {
    await this.execute({});
  }

  async invoke(inputs: Record<string, unknown>): Promise<unknown> {
    return this.execute(inputs ?? {});
  }

  private async execute(inputs: Record<string, unknown>): Promise<unknown> {
    return withCatches(
      this.ctx,
      this.resource.catches,
      inputs,
      String(this.resource.metadata.name),
      async () => {
        const items = this.ctx.expandValue(this.resource.collection, { inputs });
        if (!Array.isArray(items)) {
          throw new InvokeError(
            "INVALID_COLLECTION",
            `Run.Projection "${this.resource.metadata.name}": collection did not resolve to an array`,
            { value: items },
          );
        }
        return mapConcurrent(items, this.resource.concurrency ?? 1, async (item, index) => {
          const steps: Record<string, unknown> = {};
          await this.engine.executeSteps(this.resource.steps, steps, undefined, {
            inputs,
            item,
            index,
            items,
          });
          if (this.resource.outputs !== undefined) {
            return this.ctx.expandValue(this.resource.outputs, { steps, item, index, items, inputs });
          }
          return steps;
        });
      },
    );
  }
}

export function register(): void {}

export async function create(
  resource: RunProjectionManifest,
  ctx: ResourceContext,
): Promise<RunProjection> {
  return new RunProjection(ctx, resource);
}
