import {
  InvokeError,
  type InvokeContext,
  type ResourceContext,
  type Step,
  StepEngine,
} from "@telorun/sdk";
import { type CatchEntry, withCatches } from "./catches.js";

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
 *  CEL scope. Returns its `outputs` (or the last iteration's step map).
 *
 *  `iteration` crosses into CEL as a BigInt because the schema declares it
 *  `type: integer` and a CEL int IS a BigInt: as a JS number it typed as a
 *  double, so `iteration + 1` type-checked statically and then failed at
 *  dispatch with "no such overload: dyn<double> + int". */
class RunLoop {
  private readonly engine: StepEngine;

  constructor(
    private readonly ctx: ResourceContext,
    private readonly resource: RunLoopManifest,
  ) {
    this.engine = new StepEngine(ctx, { kind: "Loop", resourceName: String(resource.metadata.name) });
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

  /**
   * A boot `targets:` run. The context is the kernel's boot cancellation, which
   * the CLI's SIGINT handler trips — so forwarding it is what lets Ctrl-C end a
   * run parked in a retry backoff, rather than only refusing the next dispatch.
   */
  async run(invokeCtx?: InvokeContext): Promise<void> {
    await this.execute({}, invokeCtx);
  }

  /**
   * The invocation this run belongs to, forwarded to the step leaf.
   *
   * The bound entry point hands every argument through, and dropping this one
   * left the retry backoff with no cancellation token: every other point in a
   * sequence is already a cancellation point, because the kernel refuses a
   * dispatch reached after the tree was cancelled, but a wait between two
   * attempts is time spent inside the leaf where that gate cannot see it. `run()`
   * takes none by design — it is a lifecycle start that roots its own trace.
   */
  async invoke(
    inputs: Record<string, unknown>,
    invokeCtx?: InvokeContext,
  ): Promise<unknown> {
    return this.execute(inputs ?? {}, invokeCtx);
  }

  private async execute(
    inputs: Record<string, unknown>,
    invokeCtx?: InvokeContext,
  ): Promise<unknown> {
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
            !this.ctx.expandValue(this.resource.condition, {
              iteration: BigInt(iteration),
              previous,
              inputs,
            })
          ) {
            break;
          }
          const steps: Record<string, unknown> = {};
          await this.engine.executeSteps(this.resource.steps, steps, undefined, {
            iteration: BigInt(iteration),
            previous,
            inputs,
          }, invokeCtx);
          previous = steps;
          iteration += 1;
        }

        if (this.resource.outputs !== undefined) {
          return this.ctx.expandValue(this.resource.outputs, {
            steps: previous ?? {},
            previous,
            iteration: BigInt(iteration),
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
