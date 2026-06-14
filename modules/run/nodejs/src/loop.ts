import { InvokeError, type ResourceContext } from "@telorun/sdk";
import { type CatchEntry, pascalCase, type Step, StepEngine, withCatches } from "./engine.js";

interface RunLoopManifest {
  metadata: Record<string, string | number | boolean>;
  condition?: unknown;
  maxIterations?: unknown;
  inputs?: Record<string, unknown>;
  outputs?: unknown;
  catches?: CatchEntry[];
  steps: Step[];
}

/** Repeats its `steps` body while `condition` holds and/or until `maxIterations`
 *  is reached (at least one required). Adds `iteration` (0-based count) and
 *  `previous` (the prior iteration's step map, null on the first) to the body's
 *  CEL scope. Returns its `outputs` (or the last iteration's step map). */
class RunLoop {
  private readonly engine: StepEngine;

  constructor(
    private readonly ctx: ResourceContext,
    private readonly resource: RunLoopManifest,
  ) {
    this.engine = new StepEngine(ctx, `Loop${pascalCase(String(resource.metadata.name))}`);
  }

  async init(): Promise<void> {
    if (this.resource.condition === undefined && this.resource.maxIterations === undefined) {
      throw new InvokeError(
        "INVALID_LOOP",
        `Run.Loop "${this.resource.metadata.name}": at least one of condition or maxIterations is required`,
      );
    }
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
        let max = Number.POSITIVE_INFINITY;
        if (this.resource.maxIterations !== undefined) {
          const resolved = this.ctx.expandValue(this.resource.maxIterations, { inputs });
          max = Number(resolved);
          if (!Number.isFinite(max) || max < 0) {
            throw new InvokeError(
              "INVALID_LOOP",
              `Run.Loop "${this.resource.metadata.name}": maxIterations must resolve to a non-negative number, got ${JSON.stringify(resolved)}`,
            );
          }
        }
        let iteration = 0;
        let previous: Record<string, unknown> | null = null;

        while (iteration < max) {
          if (
            this.resource.condition !== undefined &&
            !this.ctx.expandValue(this.resource.condition, { iteration, previous, inputs })
          ) {
            break;
          }
          const steps: Record<string, unknown> = {};
          await this.engine.executeSteps(this.resource.steps, steps, undefined, {
            iteration,
            previous,
            inputs,
          });
          previous = steps;
          iteration += 1;
        }

        if (this.resource.outputs !== undefined) {
          return this.ctx.expandValue(this.resource.outputs, {
            steps: previous ?? {},
            previous,
            iteration,
            inputs,
          });
        }
        return previous ?? {};
      },
    );
  }
}

export function register(): void {}

export async function create(resource: RunLoopManifest, ctx: ResourceContext): Promise<RunLoop> {
  return new RunLoop(ctx, resource);
}
