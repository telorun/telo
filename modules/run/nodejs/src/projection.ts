import {
  InvokeError,
  type InvokeContext,
  type ResourceContext,
  type Step,
  StepEngine,
} from "@telorun/sdk";
import { type CatchEntry, withCatches } from "./catches.js";
import { mapConcurrent, resolveConcurrency } from "./concurrency.js";

interface RunProjectionManifest {
  metadata: Record<string, string | number | boolean>;
  collection: unknown;
  concurrency?: unknown;
  inputs?: Record<string, unknown>;
  outputs?: unknown;
  catches?: CatchEntry[];
  steps: Step[];
}

/** Runs its `steps` body once per element of `collection` and collects each
 *  element's `outputs` (raw step map when `outputs` is omitted) into an array,
 *  preserving input order even under concurrency. Adds `item` / `index` /
 *  `items` to the body's CEL scope; `index` crosses as a BigInt — see the note
 *  in `loop.ts`. */
class RunProjection {
  private readonly engine: StepEngine;

  constructor(
    private readonly ctx: ResourceContext,
    private readonly resource: RunProjectionManifest,
  ) {
    this.engine = new StepEngine(ctx, { kind: "Projection", resourceName: String(resource.metadata.name) });
  }

  async init(): Promise<void> {
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
        const items = this.ctx.expandValue(this.resource.collection, { inputs });
        if (!Array.isArray(items)) {
          throw new InvokeError(
            "INVALID_COLLECTION",
            `Run.Projection "${this.resource.metadata.name}": collection did not resolve to an array`,
            { value: items },
          );
        }
        const concurrency = resolveConcurrency(
          this.ctx,
          this.resource.concurrency,
          inputs,
          `Run.Projection "${this.resource.metadata.name}"`,
        );
        return mapConcurrent(items, concurrency, async (item, index) => {
          const steps: Record<string, unknown> = {};
          const celIndex = BigInt(index);
          await this.engine.executeSteps(this.resource.steps, steps, undefined, {
            inputs,
            item,
            index: celIndex,
            items,
          }, invokeCtx);
          if (this.resource.outputs !== undefined) {
            return this.ctx.expandValue(this.resource.outputs, {
              steps,
              item,
              index: celIndex,
              items,
              inputs,
            });
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
