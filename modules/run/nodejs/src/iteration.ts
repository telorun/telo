import { InvokeError, type ResourceContext } from "@telorun/sdk";
import {
  type CatchEntry,
  mapConcurrent,
  pascalCase,
  type Step,
  StepEngine,
  withCatches,
} from "./engine.js";

interface RunIterationManifest {
  metadata: Record<string, string | number | boolean>;
  collection: unknown;
  concurrency?: number;
  inputs?: Record<string, unknown>;
  catches?: CatchEntry[];
  steps: Step[];
}

/** Runs its `steps` body once per element of `collection`, for side-effects.
 *  Adds `item` / `index` / `items` to the body's CEL scope; `concurrency`
 *  controls how many elements run at once (default 1 = ordered). No result. */
class RunIteration {
  private readonly engine: StepEngine;

  constructor(
    private readonly ctx: ResourceContext,
    private readonly resource: RunIterationManifest,
  ) {
    this.engine = new StepEngine(ctx, `Iteration${pascalCase(String(resource.metadata.name))}`);
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
            `Run.Iteration "${this.resource.metadata.name}": collection did not resolve to an array`,
            { value: items },
          );
        }
        await mapConcurrent(items, this.resource.concurrency ?? 1, async (item, index) => {
          await this.engine.executeSteps(this.resource.steps, {}, undefined, {
            inputs,
            item,
            index,
            items,
          });
        });
        return undefined;
      },
    );
  }
}

export function register(): void {}

export async function create(
  resource: RunIterationManifest,
  ctx: ResourceContext,
): Promise<RunIteration> {
  return new RunIteration(ctx, resource);
}
