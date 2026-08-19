/**
 * `Durable.Value` — pin one impure evaluation.
 *
 * A `Run.Value` step is already journaled, so this kind would be redundant if
 * that were the whole story. What it exists for is the **collapsed region**:
 * inside a `Durable.Idempotent` or a collapsed transaction the step engine
 * records nothing of its own, because the region re-runs whole on resume — so a
 * `!cel "uuid()"` in there yields a different value the second time and
 * falsifies the very claim the region's author signed.
 *
 * Collapse suppresses per-step entries, never the journal. This kind issues a
 * DIRECT decision, so its value is recorded and replayed even where everything
 * around it is not, which is what makes `DURABLE_NONDETERMINISM`'s advice
 * actionable rather than a prescription with nowhere to write.
 */
import {
  stepPath,
  type InvokeContext,
  type ResourceContext,
  type ResourceManifest,
} from "@telorun/sdk";
import { recordPath, requireRun } from "./ambient-run.js";

interface ValueManifest extends ResourceManifest {
  value: unknown;
  outputType?: unknown;
}

class ValueController {
  constructor(
    private readonly resource: ValueManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async init(): Promise<void> {}

  async invoke(input: unknown, invokeCtx?: InvokeContext): Promise<unknown> {
    const name = String(this.resource.metadata.name);
    const handle = requireRun(invokeCtx, "Durable.Value", name);
    const path = recordPath(invokeCtx, name);
    return handle.decide(stepPath(path, "value"), "value", () =>
      this.ctx.expandValue(this.resource.value, { inputs: input ?? {} }),
    );
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(
  resource: ValueManifest,
  ctx: ResourceContext,
): Promise<ValueController> {
  return new ValueController(resource, ctx);
}
