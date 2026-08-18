import {
  InvokeError,
  type InvokeContext,
  type ResourceContext,
  type Step,
  StepEngine,
} from "@telorun/sdk";
import { type CatchEntry, withCatches } from "./catches.js";
import { forEachConcurrent, mapConcurrent, resolveConcurrency } from "./concurrency.js";

interface RunIterationManifest {
  metadata: Record<string, string | number | boolean>;
  collection: unknown;
  concurrency?: unknown;
  inputs?: Record<string, unknown>;
  catches?: CatchEntry[];
  steps: Step[];
}

/** Runs its `steps` body once per element of `collection`, for side-effects.
 *  Adds `item` / `index` to the body's CEL scope, plus `items` when the
 *  collection is an array; `concurrency` controls how many elements run at once
 *  (default 1 = ordered). A stream collection is pulled lazily, so the whole
 *  source is never in memory. No result. `index` crosses as a BigInt — see the
 *  note in `loop.ts`. */
class RunIteration {
  private readonly engine: StepEngine;

  constructor(
    private readonly ctx: ResourceContext,
    private readonly resource: RunIterationManifest,
  ) {
    this.engine = new StepEngine(ctx, { kind: "Iteration", resourceName: String(resource.metadata.name) });
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
        const collection = this.ctx.expandValue(this.resource.collection, { inputs });
        const concurrency = resolveConcurrency(
          this.ctx,
          this.resource.concurrency,
          inputs,
          `Run.Iteration "${this.resource.metadata.name}"`,
        );

        // `items` is bound only for a MATERIALIZED collection. Under a stream the
        // only value it could hold is the cursor this loop is pulling from, and
        // handing that to a step's `inputs:` is an ordinary pass-through that no
        // member-access rule catches — so a body could drain the loop's own
        // source and end the iteration early, silently. The static rule that
        // withholds the name is an early warning; this is the enforcement, and it
        // holds even where the collection's type could not be resolved.
        const run = async (
          item: unknown,
          index: number,
          items: unknown[] | undefined,
        ): Promise<void> => {
          await this.engine.executeSteps(this.resource.steps, {}, undefined, {
            inputs,
            item,
            index: BigInt(index),
            ...(items === undefined ? {} : { items }),
          }, invokeCtx);
        };

        if (Array.isArray(collection)) {
          await mapConcurrent(collection, concurrency, (item, index) =>
            run(item, index, collection),
          );
          return undefined;
        }
        if (isAsyncIterable(collection)) {
          await forEachConcurrent(collection, concurrency, (item, index) =>
            run(item, index, undefined),
          );
          return undefined;
        }
        throw new InvokeError(
          "INVALID_COLLECTION",
          `Run.Iteration "${this.resource.metadata.name}": collection resolved to neither an ` +
            `array nor a stream. A collection whose type the analyzer cannot resolve is read ` +
            `as an array, so declare the producing step's outputType (or pass the collection ` +
            `through inputType) if this is meant to be a stream.`,
          { value: collection },
        );
      },
    );
  }
}

/** Structural, not `instanceof Stream`: a controller may hand over any async
 *  iterable, and the kernel's realm collapse makes the SDK class identical
 *  across bundles only for values that went through it. */
function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value != null &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  );
}

export function register(): void {}

export async function create(
  resource: RunIterationManifest,
  ctx: ResourceContext,
): Promise<RunIteration> {
  return new RunIteration(ctx, resource);
}
